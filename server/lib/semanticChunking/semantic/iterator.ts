/**
 * Main semantic iterator - converts Docling tree to linear semantic stream
 * Stateful processing with text buffering and section tracking
 *
 * FIXED: Single-pass traversal - no double-processing of children
 * FIXED: No 'as any' type assertions
 * ADDED: Caption extraction for tables/images
 * ADDED: Key-value item support
 * ADDED: Image nodes with base64 URI (images processed later by chunker)
 */

import type { DoclingDocument, DoclingNode, DoclingTableItem, DoclingPictureItem, DoclingRef, DoclingKeyValueItem, DoclingGroupItem } from "../docling/types"
import { getPageNo, getPageNumbers, getBBox } from "../docling/types"
import { buildLookup, hasChildren, isTextItem, isTableItem, isPictureItem, isKeyValueItem, isGroupItem, getContentLayer } from "../docling/lookup"
import { extractNodeText, extractTableStructure, isNoiseText } from "../docling/extractor"
import { mapDoclingLabel } from "../docling/labels"
import type { SemanticNode } from "./types"
import { TextBuffer } from "./merger"

export interface IteratorOptions {
  /** Only process body content (exclude headers/footers) */
  filterBodyOnly?: boolean
  /** Minimum text length to include */
  minTextLength?: number
  /** Include furniture content if it looks meaningful */
  includeFurnitureWithText?: boolean
}

type SectionSource = "title" | "heading" | "slide"

interface SectionInfo {
  title: string
  level: number
  source: SectionSource
  ref: string
  pageNo?: number
  pageNumbers: number[]
  skipRef?: string
}

interface SectionStackItem {
  title: string
  level: number
  source: SectionSource
}

/**
 * Main semantic iterator - converts Docling document to semantic node stream
 *
 * Architecture:
 * - Single-pass traversal: the main loop walks the tree, processing each node exactly once
 * - No recursive text extraction: extractNodeText handles just the current node
 * - Children are traversed by the main loop, not recursively extracted
 */
export function* semanticIterator(
  doc: DoclingDocument,
  options: IteratorOptions = {}
): Generator<SemanticNode> {
  const { filterBodyOnly = true, minTextLength = 2, includeFurnitureWithText = false } = options

  const lookup = buildLookup(doc)
  const buffer = new TextBuffer()

  // Track visited nodes to prevent double-processing
  const processedNodes = new Set<string>()
  // Track nodes that were promoted to section titles and must not reappear as content
  const skipRefs = new Set<string>()

  // Section tracking
  const sectionStack: SectionStackItem[] = []
  let hasContentSinceLastSection = false

  /**
   * Get current section path
   */
  function getSectionPath(): string[] {
    return sectionStack.map((s) => s.title)
  }

  /**
   * Check if content layer should be processed
   */
  function shouldProcessContentLayer(node: DoclingNode): boolean {
    if (!filterBodyOnly) return true

    const layer = getContentLayer(node)

    // Always process body content
    if (layer === "body" || !layer) return true

    // Optionally include furniture that has meaningful text
    if (includeFurnitureWithText && layer === "furniture") {
      if (isTextItem(node) && node.text && node.text.length > 10) {
        return true
      }
    }

    return false
  }

  /**
   * Flush buffer as paragraph node
   */
  function* flushBuffer(): Generator<SemanticNode> {
    const flushed = buffer.flush()
    if (!flushed) return

    if (flushed.text.length < minTextLength) return
    if (isNoiseText(flushed.text)) return

    hasContentSinceLastSection = true
    
    // Convert bboxes Map to array format
    const bboxes = flushed.bboxes.size > 0
      ? Array.from(flushed.bboxes.entries()).map(([page, bbox]) => ({ page, ...bbox }))
      : undefined
    
    yield {
      type: "paragraph",
      ref: flushed.refs[0] || "",
      pageNo: flushed.pageNumbers[0],
      pageNumbers: flushed.pageNumbers,
      sectionPath: getSectionPath(),
      sourceRefs: flushed.refs,
      text: flushed.text,
      bbox: bboxes?.[0],  // Keep first bbox for backward compatibility
      bboxes,
    }
  }

  /**
   * Extract caption text for a table or picture
   */
  function getCaptionsForNode(node: DoclingTableItem | DoclingPictureItem): string {
    const captionTexts: string[] = []

    // Find caption references
    const captionRefs = isTableItem(node) ? node.captions : []

    for (const captionRef of captionRefs) {
      const captionNode = lookup.get(captionRef.$ref)
      if (captionNode && isTextItem(captionNode)) {
        const text = extractNodeText(captionNode)
        if (text) captionTexts.push(text)
      }
    }

    return captionTexts.join(" ")
  }

  /**
   * Extract key-value pair as text
   */
  function extractKeyValueText(node: DoclingKeyValueItem): string {
    const parts: string[] = []

    // Handle inline key/value if present
    if (node.key?.text) {
      parts.push(node.key.text)
    }
    if (node.value?.text) {
      parts.push(node.value.text)
    }

    // Also traverse children for nested key/value items
    if (node.children) {
      for (const childRef of node.children) {
        const child = lookup.get(childRef.$ref)
        if (child && isTextItem(child)) {
          const text = extractNodeText(child)
          if (text) parts.push(text)
        }
      }
    }

    return parts.join(": ")
  }

  /**
   * Extract a best-effort slide title from a chapter group.
   * Heuristic: first meaningful text node in depth-first traversal.
   */
  function extractSlideTitle(groupNode: DoclingGroupItem): { title: string; ref: string } | undefined {
    if (!groupNode.children || groupNode.children.length === 0) return undefined

    const stack = [...groupNode.children].reverse()
    const visited = new Set<string>()

    while (stack.length > 0) {
      const ref = stack.pop()
      if (!ref) continue
      const node = lookup.get(ref.$ref)
      if (!node || visited.has(node.self_ref)) continue
      visited.add(node.self_ref)

      if (isTextItem(node)) {
        const text = extractNodeText(node)?.trim()
        if (text && !isNoiseText(text)) {
          return { title: text, ref: node.self_ref }
        }
      }

      if (hasChildren(node)) {
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push(node.children[i])
        }
      }
    }

    return undefined
  }

  function normalizeSectionLevel(section: SectionInfo): number {
    if (section.source === "title") return 0
    if (section.source === "slide") return 1

    // Preserve explicit root promotion for heading-based docs (e.g., first DOCX heading).
    if (section.level === 0) {
      return 0
    }

    const requestedLevel = Math.max(1, section.level || 1)
    const maxAllowedLevel = sectionStack.length + 1
    return Math.min(requestedLevel, maxAllowedLevel)
  }

  function shouldNestSameLevelHeading(section: SectionInfo, normalizedLevel: number): boolean {
    const top = sectionStack[sectionStack.length - 1]
    if (!top) return false
    if (section.source !== "heading" || top.source !== "heading") return false
    if (top.level !== normalizedLevel) return false
    if (hasContentSinceLastSection || !buffer.isEmpty()) return false

    return false
  }

  function getSectionInfo(node: DoclingNode): SectionInfo | null {
    if (isGroupItem(node) && node.label === "chapter") {
      // If chapter already contains explicit section/title text, let children define boundaries.
      let hasExplicitTitle = false
      if (node.children) {
        for (const childRef of node.children) {
          const child = lookup.get(childRef.$ref)
          if (child && isTextItem(child) && mapDoclingLabel(child.label) === "section") {
            hasExplicitTitle = true
            break
          }
        }
      }
      if (hasExplicitTitle) return null

      const titleData = extractSlideTitle(node)
      const title = (titleData?.title || node.name || "Slide").trim()
      if (!title) return null

      return {
        title,
        level: 1,
        source: "slide",
        ref: node.self_ref,
        pageNo: getPageNo(node),
        pageNumbers: getPageNumbers(node),
        skipRef: titleData?.ref,
      }
    }

    if (!isTextItem(node)) return null

    if (node.label === "title") {
      const title = node.text?.trim()
      if (!title || title.length < 2) return null
      return {
        title,
        level: 0,
        source: "title",
        ref: node.self_ref,
        pageNo: getPageNo(node),
        pageNumbers: getPageNumbers(node),
      }
    }

    if (mapDoclingLabel(node.label) !== "section") return null

    const title = node.text?.trim()
    if (!title || title.length < 2) return null
    let level = node.level ?? 1
    // DOCX often encodes document title as first level-1 heading.
    // Promote it to root level so subsequent level-1 headings nest under it.
    if (sectionStack.length === 0 && level === 1) {
      level = 0
    }

    return {
      title,
      level,
      source: "heading",
      ref: node.self_ref,
      pageNo: getPageNo(node),
      pageNumbers: getPageNumbers(node),
    }
  }

  /**
   * Process a single node
   *
   * IMPORTANT: This only processes the current node's own content.
   * Children are handled by the main traversal loop.
   */
  function* processNode(node: DoclingNode): Generator<SemanticNode> {
    // Prevent double-processing
    if (processedNodes.has(node.self_ref)) {
      return
    }
    processedNodes.add(node.self_ref)

    // Skip nodes promoted to section titles (e.g., slide title text in PPT chapter groups)
    if (skipRefs.has(node.self_ref)) {
      return
    }

    // Skip if not in body content layer
    if (!shouldProcessContentLayer(node)) {
      return
    }

    const section = getSectionInfo(node)
    if (section) {
      const baseLevel = normalizeSectionLevel(section)
      const effectiveLevel = shouldNestSameLevelHeading(section, baseLevel)
        ? baseLevel + 1
        : baseLevel

      yield* flushBuffer()
      if (section.skipRef) {
        skipRefs.add(section.skipRef)
      }

      while (
        sectionStack.length > 0 &&
        sectionStack[sectionStack.length - 1].level >= effectiveLevel
      ) {
        sectionStack.pop()
      }
      sectionStack.push({ title: section.title, level: effectiveLevel, source: section.source })
      hasContentSinceLastSection = false

      yield {
        type: "section",
        ref: section.ref,
        pageNo: section.pageNo,
        pageNumbers: section.pageNumbers,
        sectionPath: getSectionPath(),
        sourceRefs: [section.ref],
        title: section.title,
        level: effectiveLevel,
        bbox: getBBox(node),
      }
      return
    }

    // Handle tables
    if (isTableItem(node)) {
      yield* flushBuffer()

      const { header, rows, text } = extractTableStructure(node)
      const captionText = getCaptionsForNode(node)
      const tableText = captionText ? `${captionText}\n${text}` : text

      hasContentSinceLastSection = true
      yield {
        type: "table",
        ref: node.self_ref,
        pageNo: getPageNo(node),
        pageNumbers: getPageNumbers(node),
        sectionPath: getSectionPath(),
        sourceRefs: [node.self_ref],
        text: tableText,
        header,
        rows,
        bbox: getBBox(node),
      }
      return
    }

    // Handle pictures/images - yield with base64 URI (processing happens in chunker)
    if (isPictureItem(node)) {
      yield* flushBuffer()

      const captionText = getCaptionsForNode(node)

      hasContentSinceLastSection = true
      yield {
        type: "image",
        ref: node.self_ref,
        pageNo: getPageNo(node),
        pageNumbers: getPageNumbers(node),
        sectionPath: getSectionPath(),
        sourceRefs: [node.self_ref],
        description: captionText || "",
        imageUri: node.image?.uri || "",
        mimetype: node.image?.mimetype,
        width: node.image?.size?.width,
        height: node.image?.size?.height,
        bbox: getBBox(node),
      }
      return
    }

    // Handle key-value items
    if (isKeyValueItem(node)) {
      const kvText = extractKeyValueText(node)
      if (kvText && !isNoiseText(kvText)) {
        buffer.append(kvText, node.self_ref, getPageNumbers(node), getBBox(node))
      }
      return
    }

    // Handle text items
    if (isTextItem(node)) {
      const label = node.label

      const semanticType = mapDoclingLabel(label)

      // Skip ignored types
      if (semanticType === "ignore") {
        return
      }

      // Handle comments - yield as comment nodes to be attached to context by chunker
      if (semanticType === "comment") {
        const text = extractNodeText(node)
        if (!text || isNoiseText(text)) return

        hasContentSinceLastSection = true
        yield {
          type: "comment",
          ref: node.self_ref,
          pageNo: getPageNo(node),
          pageNumbers: getPageNumbers(node),
          sectionPath: getSectionPath(),
          sourceRefs: [node.self_ref],
          text: `[COMMENT: ${text}]`,
          bbox: getBBox(node),
        }
        return
      }

      // Handle list items (flush buffer, then yield individually)
      if (label === "list_item") {
        yield* flushBuffer()

        const text = extractNodeText(node)
        if (!text || isNoiseText(text)) return

        hasContentSinceLastSection = true
        yield {
          type: "paragraph",
          ref: node.self_ref,
          pageNo: getPageNo(node),
          pageNumbers: getPageNumbers(node),
          sectionPath: getSectionPath(),
          sourceRefs: [node.self_ref],
          text,
          bbox: getBBox(node),
        }
        return
      }

      // Handle text-like content (accumulate in buffer)
      if (semanticType === "text" || semanticType === "unknown") {
        const text = extractNodeText(node)
        if (!text || isNoiseText(text)) return

        buffer.append(text, node.self_ref, getPageNumbers(node), getBBox(node))
        return
      }
    }

    // For other nodes (groups, etc.), we just traverse their children
    // The main loop handles that
  }

  /**
   * Single-pass tree traversal
   *
   * Each node is processed exactly once. Children are queued for the loop to process.
   */
  function* traverse(refs: DoclingRef[]): Generator<SemanticNode> {
    for (const refObj of refs) {
      const node = lookup.get(refObj.$ref)
      if (!node) {
        console.warn(`[semanticIterator] Reference not found: ${refObj.$ref}`)
        continue
      }

      // Process current node
      yield* processNode(node)

      // Queue children for processing
      // The main loop will process them - no recursive extraction here
      if (hasChildren(node)) {
        yield* traverse(node.children)
      }
    }
  }

  // Start traversal from body
  if (doc.body?.children) {
    yield* traverse(doc.body.children)
  }

  // Final flush
  yield* flushBuffer()
}
