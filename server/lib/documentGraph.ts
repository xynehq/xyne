import { v4 as uuidv4 } from "uuid"

// Our canonical node types (stable abstraction layer)
export type NodeType = "section" | "paragraph" | "table" | "image"

// Complete Docling type mapping based on:
// https://github.com/docling-project/docling-core/blob/main/docling_core/types/doc/labels.py
// DocItemLabel enum values

const TEXT_LIKE_TYPES = new Set([
  // Core text types
  "text",
  "paragraph",
  "list_item",
  "caption",
  "formula",
  "code",
  "reference",
  "handwritten_text",
  // Form data (often contains important info like Name, ID, amounts)
  "key_value_region",
  "footnote", // References and clarifications
])

const SECTION_TYPES = new Set([
  "section_header",
  "title",
  // Note: document_index (TOC) is noisy, skip it
])

const IGNORE_TYPES = new Set([
  // Page furniture
  "page_header",
  "page_footer",
  // TOC/Index - noisy for retrieval
  "document_index",
  // Group/structural labels that appear as text items
  "list", // List container (list_items are separate)
  "key_value_area", // Group label, children are processed
  // Form structural elements (not the data itself)
  "form",
  "grading_scale",
  "empty_value",
  "checkbox_selected",
  "checkbox_unselected",
  "field_region",
  "field_heading",
  "field_item",
  "field_key",
  "field_value",
  "field_hint",
  "marker",
])

// Helper to categorize Docling types
function mapDoclingType(doclingType: string): NodeType | "ignore" | "unknown" {
  if (SECTION_TYPES.has(doclingType)) return "section"
  if (TEXT_LIKE_TYPES.has(doclingType)) return "paragraph"
  if (doclingType === "table") return "table"
  if (doclingType === "picture" || doclingType === "chart") return "image"
  if (IGNORE_TYPES.has(doclingType)) return "ignore"
  return "unknown"
}

export interface DocumentNode {
  id: string
  type: NodeType
  text?: string
  children: DocumentNode[]
  metadata: {
    page_no?: number
    section_path: string[]
    depth: number
    source?: string
    docling_type?: string // Store original type for debugging
  }
  raw?: any
}

export interface DocumentGraph {
  root: DocumentNode[]
}

interface DoclingRef {
  $ref: string
}

interface DoclingTextItem {
  self_ref: string
  label: string
  text?: string
  level?: number
  marker?: string // List item numbering (e.g., "1.", "[1]", "a.")
  enumerated?: boolean // Whether this is an enumerated list item
  prov?: Array<{
    page_no?: number
    bbox?: number[]
  }>
}

interface DoclingTableItem {
  self_ref: string
  data?: any
  prov?: Array<{
    page_no?: number
  }>
}

interface DoclingPictureItem {
  self_ref: string
  prov?: Array<{
    page_no?: number
  }>
}

interface DoclingGroupItem {
  self_ref: string
  children?: DoclingRef[]
  label?: string
  name?: string
  prov?: Array<{
    page_no?: number
  }>
}

interface DoclingDocument {
  body?: {
    children?: DoclingRef[]
  }
  texts?: DoclingTextItem[]
  tables?: DoclingTableItem[]
  pictures?: DoclingPictureItem[]
  groups?: DoclingGroupItem[]
}

type DoclingNode =
  | DoclingTextItem
  | DoclingTableItem
  | DoclingPictureItem
  | DoclingGroupItem

function hasLabel(node: DoclingNode): node is DoclingTextItem {
  return "label" in node && typeof (node as any).label === "string"
}

function hasChildren(node: DoclingNode): node is DoclingGroupItem {
  return "children" in node && Array.isArray((node as any).children)
}

function buildLookup(doc: DoclingDocument): Map<string, DoclingNode> {
  const map = new Map<string, DoclingNode>()

  for (const t of doc.texts || []) {
    map.set(t.self_ref, t)
  }

  for (const t of doc.tables || []) {
    map.set(t.self_ref, t)
  }

  for (const p of doc.pictures || []) {
    map.set(p.self_ref, p)
  }

  for (const g of doc.groups || []) {
    map.set(g.self_ref, g)
  }

  return map
}

function tableToText(table: DoclingTableItem): string {
  const cells = table.data?.table_cells || []
  const rows = new Map<number, string[]>()

  for (const cell of cells) {
    const row = cell.start_row_offset_idx ?? cell.row ?? 0
    if (!rows.has(row)) rows.set(row, [])
    rows.get(row)!.push(cell.text)
  }

  return Array.from(rows.values())
    .map((r) => r.join(" | "))
    .join("\n")
}

function isNoiseParagraph(text: string): boolean {
  if (text.length < 5) return true
  if (/^-{3,}$/.test(text)) return true
  if (/^_{3,}$/.test(text)) return true
  if (/^(page\s+\d+)$/i.test(text)) return true
  return false
}

export function convertDoclingToGraph(
  doc: DoclingDocument,
  source?: string,
): DocumentGraph {
  const lookup = buildLookup(doc)
  const root: DocumentNode[] = []
  const unknownTypes = new Set<string>()

  // Coverage tracking counters
  const stats = {
    totalNodes: 0,
    processedNodes: 0,
    ignoredNodes: 0,
    unknownNodes: 0,
    ignoredWithText: [] as Array<{ type: string; text: string }>,
  }

  let currentSection: DocumentNode | null = null
  const sectionStack: DocumentNode[] = []
  const seenHeaders = new Set<string>()

  function ensureSection(): DocumentNode {
    if (currentSection) return currentSection

    currentSection = {
      id: uuidv4(),
      type: "section",
      text: "ROOT",
      children: [],
      metadata: {
        depth: 0,
        section_path: [],
        source,
      },
      raw: null,
    }
    root.push(currentSection)
    return currentSection
  }

  // Process a single node and return true if handled
  function processNode(node: DoclingNode): boolean {
    stats.totalNodes++

    // Handle text items with labels
    if (hasLabel(node)) {
      const doclingType = node.label
      let mappedType = mapDoclingType(doclingType)

      // Handle unknown types
      if (mappedType === "unknown") {
        stats.unknownNodes++
        if (!unknownTypes.has(doclingType)) {
          unknownTypes.add(doclingType)
          console.warn(
            `[documentGraph] Unknown type: "${doclingType}" → using fallback`,
          )
        }
        mappedType = "paragraph"
      }

      // Track ignored nodes (but still check for content)
      if (mappedType === "ignore") {
        stats.ignoredNodes++
        const nodeText = node.text?.trim()
        if (nodeText && nodeText.length > 0) {
          // This is important - we might be losing content!
          stats.ignoredWithText.push({
            type: doclingType,
            text:
              nodeText.substring(0, 100) + (nodeText.length > 100 ? "..." : ""),
          })
        }
        return true
      }

      // Handle section headers
      if (mappedType === "section") {
        stats.processedNodes++
        const depth = node.level || 1
        const title = node.text?.trim()

        if (!title || title.length < 2) return true

        const pageNo = node.prov?.[0]?.page_no
        const headerKey = pageNo !== undefined ? `${title}_p${pageNo}` : title
        if (seenHeaders.has(headerKey)) return true
        seenHeaders.add(headerKey)

        while (sectionStack.length >= depth) {
          sectionStack.pop()
        }

        const sectionNode: DocumentNode = {
          id: uuidv4(),
          type: "section",
          text: title,
          children: [],
          metadata: {
            depth,
            section_path: [...sectionStack.map((s) => s.text || ""), title],
            page_no: node.prov?.[0]?.page_no,
            source,
            docling_type: doclingType,
          },
          raw: node,
        }

        if (sectionStack.length === 0) {
          root.push(sectionNode)
        } else {
          sectionStack[sectionStack.length - 1].children.push(sectionNode)
        }

        sectionStack.push(sectionNode)
        currentSection = sectionNode
        return true
      }

      // Handle text-like content
      if (mappedType === "paragraph") {
        stats.processedNodes++
        let text = node.text?.trim()

        if (!text || isNoiseParagraph(text)) return true

        // Preserve list numbering
        if ((node as DoclingTextItem).marker) {
          const marker = (node as DoclingTextItem).marker?.trim()
          if (marker) {
            text = `${marker} ${text}`
          }
        }

        const paragraphNode: DocumentNode = {
          id: uuidv4(),
          type: "paragraph",
          text,
          children: [],
          metadata: {
            depth: sectionStack.length,
            section_path: sectionStack.map((s) => s.text || ""),
            page_no: node.prov?.[0]?.page_no,
            source,
            docling_type: doclingType,
          },
          raw: node,
        }

        ensureSection().children.push(paragraphNode)
        return true
      }
    }

    // Handle tables
    if ("data" in node && node.self_ref?.startsWith("#/tables/")) {
      stats.processedNodes++
      const tableNode: DocumentNode = {
        id: uuidv4(),
        type: "table",
        text: tableToText(node as DoclingTableItem),
        children: [],
        metadata: {
          depth: sectionStack.length,
          section_path: sectionStack.map((s) => s.text || ""),
          page_no: node.prov?.[0]?.page_no,
          source,
          docling_type: "table",
        },
        raw: node,
      }

      ensureSection().children.push(tableNode)
      return true
    }

    // Handle images/pictures
    if (node.self_ref?.startsWith("#/pictures/")) {
      stats.processedNodes++
      const imageNode: DocumentNode = {
        id: uuidv4(),
        type: "image",
        children: [],
        metadata: {
          depth: sectionStack.length,
          section_path: sectionStack.map((s) => s.text || ""),
          page_no: node.prov?.[0]?.page_no,
          source,
          docling_type: "picture",
        },
        raw: node,
      }

      ensureSection().children.push(imageNode)
      return true
    }

    return false
  }

  // Recursive traversal
  function traverse(refs: DoclingRef[]): void {
    for (const refObj of refs) {
      const ref = refObj.$ref
      const node = lookup.get(ref)
      if (!node) {
        console.warn(`[documentGraph] Reference not found: ${ref}`)
        continue
      }

      // Process the node (sections, paragraphs, tables, images)
      // Note: Groups are NOT processed as nodes, only their children are traversed
      processNode(node)

      // ALWAYS traverse children if they exist
      // This ensures we don't miss content in nested structures
      if (hasChildren(node)) {
        const groupNode = node as DoclingGroupItem
        if (groupNode.children && groupNode.children.length > 0) {
          traverse(groupNode.children)
        }
      }
    }
  }

  if (doc.body?.children) {
    traverse(doc.body.children)
  }

  // Log coverage summary
  console.log(`\n📊 Docling Coverage Summary:`)
  console.log(`   Total nodes: ${stats.totalNodes}`)
  console.log(`   Processed: ${stats.processedNodes}`)
  console.log(`   Ignored: ${stats.ignoredNodes}`)
  console.log(`   Unknown: ${stats.unknownNodes}`)

  // Filter out known-safe ignored types (page headers/footers) from warnings
  const safeToIgnore = new Set(["page_header", "page_footer"])
  const problematicIgnored = stats.ignoredWithText.filter(
    ({ type }) => !safeToIgnore.has(type),
  )

  if (problematicIgnored.length > 0) {
    console.warn(
      `\n⚠️  WARNING: ${problematicIgnored.length} ignored nodes have text content:`,
    )
    problematicIgnored.slice(0, 5).forEach(({ type, text }) => {
      console.warn(`   - ${type}: "${text.substring(0, 60)}..."`)
    })
    if (problematicIgnored.length > 5) {
      console.warn(`   ... and ${problematicIgnored.length - 5} more`)
    }
  } else {
    console.log(`   ✅ No data loss (all ignored nodes have no content)`)
  }

  if (unknownTypes.size > 0) {
    console.warn(`\n⚠️  Unknown types: ${Array.from(unknownTypes).join(", ")}`)
  }

  return { root }
}
