/**
 * Structure-aware chunking for DocumentGraph
 *
 * Chunks by nodes (paragraphs, tables, images) with:
 * - Section boundaries (hard separation)
 * - Token-based sizing (chars / 4)
 * - Table splitting with header repetition
 * - Page span tracking
 * - Section context preservation (every chunk starts with section title)
 */

import type { DocumentGraph, DocumentNode } from "./documentGraph"
import type { ChunkMetadata } from "../types"

export interface ChunkConfig {
  maxTokens?: number // default 400
}

export interface ChunkResult {
  text: string
  metadata: ChunkMetadata
}

interface AccumulatedChunk {
  text: string
  pages: number[]
  labels: string[]
}

/**
 * Estimate token count (fast approximation: chars / 4)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Extract unique page numbers from array
 */
function getUniquePages(pages: (number | undefined)[]): number[] {
  const unique = new Set<number>()
  for (const p of pages) {
    if (p !== undefined && p !== null) {
      unique.add(p)
    }
  }
  return Array.from(unique).sort((a, b) => a - b)
}

/**
 * Split text into sentences for long paragraph handling
 * Uses punctuation-based splitting
 */
function splitIntoSentences(text: string): string[] {
  // Split on sentence boundaries while preserving the punctuation
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  // If no sentences found (no punctuation), split by length
  if (sentences.length === 0) {
    // Split into chunks of ~100 chars
    const chunks: string[] = []
    for (let i = 0; i < text.length; i += 100) {
      chunks.push(text.slice(i, i + 100).trim())
    }
    return chunks.filter((s) => s.length > 0)
  }

  return sentences
}

/**
 * Deduplicate labels array
 */
function deduplicateLabels(labels: string[]): string[] {
  return Array.from(new Set(labels))
}

/**
 * Build final chunk result with proper metadata
 */
function buildChunk(
  acc: AccumulatedChunk,
  sectionPath: string[],
  chunkIndex: number,
): ChunkResult {
  return {
    text: acc.text,
    metadata: {
      chunk_index: chunkIndex,
      page_numbers: getUniquePages(acc.pages),
      block_labels: deduplicateLabels(acc.labels),
      section_path: sectionPath,
    },
  }
}

/**
 * Create fresh accumulated chunk starting with section title
 */
function resetAccumulatedChunk(sectionTitle: string): AccumulatedChunk {
  return {
    text: sectionTitle,
    pages: [],
    labels: ["section"],
  }
}

/**
 * Main entry point: chunk an entire document graph
 */
export function chunkGraph(
  graph: DocumentGraph,
  config: ChunkConfig = {},
): ChunkResult[] {
  const maxTokens = config.maxTokens ?? 400
  const results: ChunkResult[] = []
  let chunkIndex = 0

  for (const section of graph.root) {
    const sectionChunks = chunkSection(section, maxTokens, chunkIndex)
    results.push(...sectionChunks)
    chunkIndex += sectionChunks.length
  }

  // Update chunk indices
  results.forEach((chunk, idx) => {
    chunk.metadata.chunk_index = idx
  })

  return results
}

/**
 * Chunk a single section and its children
 */
function chunkSection(
  section: DocumentNode,
  maxTokens: number,
  startIndex: number,
): ChunkResult[] {
  const sectionTitle = section.text ?? "ROOT"
  const sectionPath = section.metadata.section_path
  const chunks: ChunkResult[] = []
  let chunkIndex = startIndex

  // Start with section title in the chunk
  let currentAcc = resetAccumulatedChunk(sectionTitle)
  let currentTokens = estimateTokens(sectionTitle)

  // Include section's own page number if available
  if (section.metadata.page_no !== undefined) {
    currentAcc.pages.push(section.metadata.page_no)
  }

  for (const node of section.children) {
    switch (node.type) {
      case "section":
        // Nested section: flush current, then recurse
        if (currentAcc.text !== sectionTitle) {
          chunks.push(buildChunk(currentAcc, sectionPath, chunkIndex++))
          currentAcc = resetAccumulatedChunk(sectionTitle)
          currentTokens = estimateTokens(sectionTitle)
          if (section.metadata.page_no !== undefined) {
            currentAcc.pages.push(section.metadata.page_no)
          }
        }
        const nestedChunks = chunkSection(node, maxTokens, chunkIndex)
        chunks.push(...nestedChunks)
        chunkIndex += nestedChunks.length
        break

      case "paragraph":
        const paraText = node.text ?? ""
        const paraTokens = estimateTokens(paraText)
        const paraPage = node.metadata.page_no

        if (paraTokens > maxTokens) {
          // Long paragraph: flush current, split into sentences
          if (currentAcc.text !== sectionTitle) {
            chunks.push(buildChunk(currentAcc, sectionPath, chunkIndex++))
          }

          const sentences = splitIntoSentences(paraText)
          let sentenceAcc = resetAccumulatedChunk(sectionTitle)
          let sentenceTokens = estimateTokens(sectionTitle)

          for (const sentence of sentences) {
            const sentTokens = estimateTokens(sentence)

            if (sentenceTokens + sentTokens <= maxTokens) {
              sentenceAcc.text += "\n" + sentence
              sentenceAcc.labels.push("paragraph")
              if (paraPage !== undefined) {
                sentenceAcc.pages.push(paraPage)
              }
              sentenceTokens += sentTokens
            } else {
              // Flush sentence batch
              if (sentenceAcc.text !== sectionTitle) {
                chunks.push(buildChunk(sentenceAcc, sectionPath, chunkIndex++))
              }
              // Start new batch with this sentence
              sentenceAcc = resetAccumulatedChunk(sectionTitle)
              sentenceAcc.text += "\n" + sentence
              sentenceAcc.labels = ["section", "paragraph"]
              sentenceAcc.pages = getUniquePages([
                section.metadata.page_no,
                paraPage,
              ])
              sentenceTokens = estimateTokens(sectionTitle) + sentTokens
            }
          }

          // Flush remaining sentences
          if (sentenceAcc.text !== sectionTitle) {
            chunks.push(buildChunk(sentenceAcc, sectionPath, chunkIndex++))
          }

          // Reset for next content
          currentAcc = resetAccumulatedChunk(sectionTitle)
          currentTokens = estimateTokens(sectionTitle)
          if (section.metadata.page_no !== undefined) {
            currentAcc.pages.push(section.metadata.page_no)
          }
        } else if (currentTokens + paraTokens <= maxTokens) {
          // Add to current chunk
          currentAcc.text += "\n" + paraText
          currentAcc.labels.push("paragraph")
          if (paraPage !== undefined) {
            currentAcc.pages.push(paraPage)
          }
          currentTokens += paraTokens
        } else {
          // Flush and start new chunk with section title
          chunks.push(buildChunk(currentAcc, sectionPath, chunkIndex++))
          currentAcc = resetAccumulatedChunk(sectionTitle)
          currentAcc.text += "\n" + paraText
          currentAcc.labels = ["section", "paragraph"]
          currentAcc.pages = getUniquePages([
            section.metadata.page_no,
            paraPage,
          ])
          currentTokens = estimateTokens(sectionTitle) + paraTokens
        }
        break

      case "table":
        // Tables are handled separately with header repetition
        // Flush current chunk first
        if (currentAcc.text !== sectionTitle) {
          chunks.push(buildChunk(currentAcc, sectionPath, chunkIndex++))
        }

        // Chunk table with section context
        const tableChunks = chunkTable(
          node,
          sectionTitle,
          sectionPath,
          maxTokens,
        )
        for (const tableChunk of tableChunks) {
          tableChunk.metadata.chunk_index = chunkIndex++
          chunks.push(tableChunk)
        }

        // Reset for next content
        currentAcc = resetAccumulatedChunk(sectionTitle)
        currentTokens = estimateTokens(sectionTitle)
        if (section.metadata.page_no !== undefined) {
          currentAcc.pages.push(section.metadata.page_no)
        }
        break

      case "image":
        // Images treated as atomic units
        const imageText = node.text ?? "[image]"
        const imageTokens = estimateTokens(imageText)
        const imagePage = node.metadata.page_no

        if (currentTokens + imageTokens <= maxTokens) {
          currentAcc.text += "\n" + imageText
          currentAcc.labels.push("image")
          if (imagePage !== undefined) {
            currentAcc.pages.push(imagePage)
          }
          currentTokens += imageTokens
        } else {
          chunks.push(buildChunk(currentAcc, sectionPath, chunkIndex++))
          currentAcc = resetAccumulatedChunk(sectionTitle)
          currentAcc.text += "\n" + imageText
          currentAcc.labels = ["section", "image"]
          currentAcc.pages = getUniquePages([
            section.metadata.page_no,
            imagePage,
          ])
          currentTokens = estimateTokens(sectionTitle) + imageTokens
        }
        break
    }
  }

  // Flush remaining content
  if (currentAcc.text !== sectionTitle || chunks.length === 0) {
    chunks.push(buildChunk(currentAcc, sectionPath, chunkIndex++))
  }

  return chunks
}

/**
 * Chunk a table with header repetition
 * Each chunk contains: section title + header + N rows
 * Handles oversized rows by splitting them into separate chunks
 */
function chunkTable(
  tableNode: DocumentNode,
  sectionTitle: string,
  sectionPath: string[],
  maxTokens: number,
): ChunkResult[] {
  const { header, dataRows } = extractTableStructure(tableNode)
  const tablePage = tableNode.metadata.page_no

  // Handle empty table
  if (!header || header.length === 0) {
    return [
      {
        text: sectionTitle + "\n[empty table]",
        metadata: {
          chunk_index: 0,
          page_numbers: tablePage !== undefined ? [tablePage] : [],
          block_labels: ["section", "table"],
          section_path: sectionPath,
        },
      },
    ]
  }

  const headerText = header.join(" | ")
  const headerTokens = estimateTokens(headerText)
  const sectionTokens = estimateTokens(sectionTitle)
  const baseTokens = sectionTokens + headerTokens

  const chunks: ChunkResult[] = []
  let currentRows: string[][] = []
  let currentTokens = baseTokens

  for (const row of dataRows) {
    const rowText = row.join(" | ")
    const rowTokens = estimateTokens(rowText)

    // Check if this single row is too large
    if (rowTokens > maxTokens - sectionTokens) {
      // Flush any accumulated rows first
      if (currentRows.length > 0) {
        chunks.push(
          buildTableChunk(
            sectionTitle,
            sectionPath,
            header,
            currentRows,
            tablePage,
            chunks.length,
          ),
        )
        currentRows = []
        currentTokens = baseTokens
      }

      // Handle oversized row: truncate or split
      // For now, put the oversized row in its own chunk
      console.warn(
        `[chunkGraph] Table row exceeds token limit (${rowTokens} tokens). ` +
          `Creating separate chunk for oversized row.`,
      )
      chunks.push(
        buildTableChunk(
          sectionTitle,
          sectionPath,
          header,
          [row],
          tablePage,
          chunks.length,
        ),
      )
      continue
    }

    // Check if adding this row would exceed limit
    if (currentTokens + rowTokens <= maxTokens) {
      currentRows.push(row)
      currentTokens += rowTokens
    } else {
      // Flush current batch
      if (currentRows.length > 0) {
        chunks.push(
          buildTableChunk(
            sectionTitle,
            sectionPath,
            header,
            currentRows,
            tablePage,
            chunks.length,
          ),
        )
      }
      // Start new batch with this row
      currentRows = [row]
      currentTokens = baseTokens + rowTokens
    }
  }

  // Flush remaining rows
  if (currentRows.length > 0) {
    chunks.push(
      buildTableChunk(
        sectionTitle,
        sectionPath,
        header,
        currentRows,
        tablePage,
        chunks.length,
      ),
    )
  }

  return chunks
}

/**
 * Build a single table chunk with proper formatting
 */
function buildTableChunk(
  sectionTitle: string,
  sectionPath: string[],
  header: string[],
  rows: string[][],
  tablePage: number | undefined,
  chunkIndex: number,
): ChunkResult {
  const lines: string[] = [sectionTitle, header.join(" | ")]

  for (const row of rows) {
    lines.push(row.join(" | "))
  }

  return {
    text: lines.join("\n"),
    metadata: {
      chunk_index: chunkIndex,
      page_numbers: tablePage !== undefined ? [tablePage] : [],
      block_labels: ["section", "table"],
      section_path: sectionPath,
    },
  }
}

/**
 * Extract table structure (header + data rows) from Docling table node
 */
function extractTableStructure(tableNode: DocumentNode): {
  header: string[]
  dataRows: string[][]
} {
  const raw = tableNode.raw
  const cells = raw?.data?.table_cells ?? []

  if (!cells || cells.length === 0) {
    return { header: [], dataRows: [] }
  }

  // Group cells by row index
  const rows = new Map<number, string[]>()

  for (const cell of cells) {
    const rowIdx = cell.start_row_offset_idx ?? cell.row ?? 0
    if (!rows.has(rowIdx)) {
      rows.set(rowIdx, [])
    }
    const row = rows.get(rowIdx)!
    // Ensure array is large enough
    const colIdx = cell.start_col_offset_idx ?? cell.col ?? 0
    while (row.length <= colIdx) {
      row.push("")
    }
    row[colIdx] = cell.text ?? ""
  }

  // Find header row index (column_header === true)
  let headerRowIndex: number | null = null
  for (const cell of cells) {
    if (cell.column_header === true) {
      headerRowIndex = cell.start_row_offset_idx ?? cell.row ?? 0
      break
    }
  }

  // Sort rows by index
  const sortedEntries = Array.from(rows.entries()).sort((a, b) => a[0] - b[0])

  // If no header found, use first row as fallback
  if (headerRowIndex === null && sortedEntries.length > 0) {
    headerRowIndex = sortedEntries[0][0]
  }

  let header: string[] = []
  const dataRows: string[][] = []

  for (const [idx, row] of sortedEntries) {
    if (idx === headerRowIndex) {
      header = row
    } else if (headerRowIndex !== null && idx > headerRowIndex) {
      dataRows.push(row)
    }
  }

  return { header, dataRows }
}
