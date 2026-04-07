/**
 * Main chunking implementation
 * Converts semantic node stream to token-aware chunks
 *
 * Follows the same rules as chunkGraph.ts:
 * - Every chunk starts with the section title
 * - Images are merged with content (not isolated)
 * - Tables get their own chunks but with section title prepended
 * - Section context is preserved via sectionPath and prepended title
 * - Full traceability: refs are propagated from source nodes
 */

import type { SemanticNode, SemanticSectionNode, SemanticParagraphNode, SemanticTableNode, SemanticImageNode } from "../semantic/types"
import type { Chunk, ChunkingOptions } from "./types"
import { estimateTokens, splitIntoSentences, getUnique, generateChunkId, getOverlapText } from "./utils"

interface AccumulatedChunk {
  text: string
  tokens: number
  nodes: SemanticNode[]  // Source of truth - all other metadata derived from this
}

/**
 * Main chunking function - converts semantic stream to chunks
 */
export function chunkSemanticStream(
  nodes: Iterable<SemanticNode>,
  options: ChunkingOptions = {}
): Chunk[] {
  const {
    maxTokens = 512,
    minTokens = 50,
    targetTokens: userTargetTokens,
  } = options

  const targetTokens = userTargetTokens ?? Math.floor((minTokens + maxTokens) / 2)
  const overlapSentences = 2
  const maxOverlapTokens = Math.floor(maxTokens * 0.15)

  const chunks: Chunk[] = []
  let chunkIndex = 0

  // Current section state (from iterator - trust it)
  let currentSectionPath: string[] = []

  // Current accumulation state
  let currentAcc: AccumulatedChunk | null = null

  // NEW: Track content since section boundary
  let hasContentSinceSection = false

  // NEW: Track last original text for overlap (prevents pollution)
  let lastOriginalText = ""

  /**
   * Get the current section title text (for prepending to chunks)
   */
  function getSectionTitleText(): string {
    if (currentSectionPath.length === 0) return "ROOT"
    return currentSectionPath[currentSectionPath.length - 1]
  }

  /**
   * Create a fresh accumulated chunk starting with section title
   */
  function resetAccumulatedChunk(): AccumulatedChunk {
    const sectionTitle = getSectionTitleText()
    return {
      text: sectionTitle,
      tokens: estimateTokens(sectionTitle),
      nodes: [],
    }
  }

  function appendLine(base: string, line: string): string {
    const prefix = base.trimEnd()
    if (!prefix) return line
    return `${prefix}\n${line}`
  }

  function isSameSectionPath(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false
    }
    return true
  }

  /**
   * Derive labels from nodes
   */
  function deriveLabels(nodes: SemanticNode[]): string[] {
    const labels = new Set<string>(["section"])
    for (const node of nodes) {
      if (node.type === "paragraph") labels.add("paragraph")
      if (node.type === "table") labels.add("table")
      if (node.type === "image") labels.add("image")
      if (node.type === "comment") labels.add("comment")
    }
    return Array.from(labels)
  }

  /**
   * Derive page numbers from nodes
   */
  function derivePageNumbers(nodes: SemanticNode[]): number[] {
    const pages = new Set<number>()
    for (const node of nodes) {
      if (node.pageNo !== undefined) pages.add(node.pageNo)
      if (node.pageNumbers) {
        for (const p of node.pageNumbers) pages.add(p)
      }
    }
    return Array.from(pages).sort((a, b) => a - b)
  }

  /**
   * Derive section paths from nodes
   */
  function deriveSectionPaths(nodes: SemanticNode[]): string[][] {
    const paths: string[][] = []
    const seen = new Set<string>()
    
    for (const node of nodes) {
      const pathKey = JSON.stringify(node.sectionPath)
      if (!seen.has(pathKey)) {
        seen.add(pathKey)
        paths.push([...node.sectionPath])
      }
    }
    
    return paths
  }

  /**
   * Derive refs from nodes
   */
  function deriveRefs(nodes: SemanticNode[]): string[] {
    const refs = new Set<string>()
    for (const node of nodes) {
      refs.add(node.ref)
      for (const ref of node.sourceRefs) {
        refs.add(ref)
      }
    }
    return Array.from(refs)
  }

  /**
   * Build final chunk from accumulated content
   * All metadata derived from nodes (source of truth)
   */
  function buildChunk(acc: AccumulatedChunk): Chunk {
    return {
      id: generateChunkId(chunkIndex),
      text: acc.text,
      metadata: {
        index: chunkIndex++,
        pageNumbers: derivePageNumbers(acc.nodes),
        sectionPaths: deriveSectionPaths(acc.nodes),
        labels: deriveLabels(acc.nodes),
        tokenCount: acc.tokens,
        charCount: acc.text.length,
      },
      refs: deriveRefs(acc.nodes),
    }
  }

  /**
   * Build a single table chunk with proper formatting
   * Format: sectionTitle + header + rows (each row on new line)
   */
  function buildTableChunk(
    sectionTitle: string,
    headerText: string,
    rows: string[][],
    tablePages: number[],
    tableRefs: string[],
    idx: number
  ): Chunk {
    const lines: string[] = [sectionTitle, headerText]

    for (const row of rows) {
      lines.push(row.join(" | "))
    }

    const text = lines.join("\n")

    return {
      id: generateChunkId(idx),
      text,
      metadata: {
        index: idx,
        pageNumbers: tablePages,
        sectionPaths: [[...currentSectionPath]],
        labels: ["section", "table"],
        tokenCount: estimateTokens(text),
        charCount: text.length,
      },
      refs: getUnique(tableRefs),
    }
  }

  /**
   * Flush current accumulated content as a chunk
   * Adds overlap for mid-section splits, clean boundaries otherwise
   */
  function flushChunk(addOverlap = false): void {
    if (!currentAcc) return
    const hasContent = currentAcc.text !== getSectionTitleText()

    // Only create chunk if it has content beyond just the section title
    if (!hasContent) {
      currentAcc = null
      hasContentSinceSection = false
      return
    }

    // Store original text BEFORE any overlap is added (prevents cascade pollution)
    const originalText = currentAcc.text

    // Add overlap for mid-section splits only
    if (addOverlap && lastOriginalText) {
      const overlap = getOverlapText(lastOriginalText, overlapSentences, maxOverlapTokens, estimateTokens)
      if (overlap) {
        currentAcc.text = overlap + "\n" + currentAcc.text
        currentAcc.tokens = estimateTokens(currentAcc.text)
      }
    }

    chunks.push(buildChunk(currentAcc))
    
    // Store ORIGINAL text for next overlap (not the mutated version with overlap)
    lastOriginalText = originalText
    
    currentAcc = null
    hasContentSinceSection = false
  }

  /**
   * Process each semantic node
   */
  for (const node of nodes) {
    switch (node.type) {
      case "section": {
        const sectionNode = node as SemanticSectionNode

        // Flush if current chunk is large enough (section-aware packing)
        if (currentAcc && currentAcc.tokens >= targetTokens) {
          flushChunk(false)
        }

        // Update section context (trust iterator's sectionPath)
        currentSectionPath = sectionNode.sectionPath
        hasContentSinceSection = false

        // Inject section title into current accumulator or create new one
        if (!currentAcc) {
          currentAcc = resetAccumulatedChunk()
        } else {
          const sectionTitle = sectionNode.title
          currentAcc.text = appendLine(currentAcc.text, sectionTitle)
          currentAcc.tokens += estimateTokens(sectionTitle)
          // Track the section node (not its path directly - will be derived from nodes)
          currentAcc.nodes.push(sectionNode)
        }
        break
      }

      case "paragraph": {
        const paraNode = node as SemanticParagraphNode
        const paraText = paraNode.text
        const paraTokens = estimateTokens(paraText)
        const paraPages = getUnique(
          (paraNode.pageNumbers && paraNode.pageNumbers.length > 0)
            ? paraNode.pageNumbers
            : [paraNode.pageNo].filter((p): p is number => p !== undefined)
        )
        const paraRefs = paraNode.sourceRefs

        // Initialize accumulator if needed
        if (!currentAcc) {
          currentAcc = resetAccumulatedChunk()
        }

        const currentTokens = currentAcc.tokens

        // If paragraph is too long, split by sentences
        if (paraTokens > maxTokens) {
          // Flush current content first
          if (currentAcc.text !== getSectionTitleText()) {
            flushChunk(hasContentSinceSection) // Add overlap if mid-section
            currentAcc = resetAccumulatedChunk()
          }

          const sentences = splitIntoSentences(paraText)
          const sectionTokens = estimateTokens(getSectionTitleText())
          let sentenceAcc = resetAccumulatedChunk()
          let sentenceTokens = sentenceAcc.tokens

          for (const sentence of sentences) {
            const sentTokens = estimateTokens(sentence)

            if (sentenceTokens + sentTokens <= maxTokens) {
              sentenceAcc.text = appendLine(sentenceAcc.text, sentence)
              sentenceAcc.tokens = sentenceTokens + sentTokens
              // Track nodes - create a paragraph node for this sentence
              sentenceAcc.nodes.push({
                type: "paragraph",
                ref: paraNode.ref,
                pageNo: paraNode.pageNo,
                pageNumbers: paraPages,
                sectionPath: paraNode.sectionPath,
                sourceRefs: paraRefs,
                text: sentence,
              } as SemanticParagraphNode)
              sentenceTokens += sentTokens
            } else {
              // Flush sentence batch with overlap (mid-paragraph = mid-section)
              if (sentenceAcc.text !== getSectionTitleText()) {
                const originalText = sentenceAcc.text
                // Add overlap from last chunk
                if (lastOriginalText) {
                  const overlap = getOverlapText(lastOriginalText, overlapSentences, maxOverlapTokens, estimateTokens)
                  if (overlap) {
                    sentenceAcc.text = overlap + "\n" + sentenceAcc.text
                    sentenceAcc.tokens = estimateTokens(sentenceAcc.text)
                  }
                }
                chunks.push(buildChunk(sentenceAcc))
                lastOriginalText = originalText
              }
              // Start new batch with this sentence
              sentenceAcc = resetAccumulatedChunk()
              sentenceAcc.text = appendLine(sentenceAcc.text, sentence)
              sentenceAcc.tokens = sectionTokens + sentTokens
              // Track the sentence as a node
              sentenceAcc.nodes.push({
                type: "paragraph",
                ref: paraNode.ref,
                pageNo: paraNode.pageNo,
                pageNumbers: paraPages,
                sectionPath: paraNode.sectionPath,
                sourceRefs: paraRefs,
                text: sentence,
              } as SemanticParagraphNode)
            }
          }

          // Flush remaining sentences
          if (sentenceAcc.text !== getSectionTitleText()) {
            const originalText = sentenceAcc.text
            // Add overlap for last batch too
            if (lastOriginalText) {
              const overlap = getOverlapText(lastOriginalText, overlapSentences, maxOverlapTokens, estimateTokens)
              if (overlap) {
                sentenceAcc.text = overlap + "\n" + sentenceAcc.text
                sentenceAcc.tokens = estimateTokens(sentenceAcc.text)
              }
            }
            chunks.push(buildChunk(sentenceAcc))
            lastOriginalText = originalText
          }

          // Reset for next content
          currentAcc = resetAccumulatedChunk()
          hasContentSinceSection = true
        } else if (currentTokens + paraTokens <= maxTokens) {
          // Add to current chunk
          currentAcc.text = appendLine(currentAcc.text, paraText)
          currentAcc.tokens += paraTokens
          currentAcc.nodes.push(paraNode)  // Track the node
          hasContentSinceSection = true
        } else {
          // Flush and start new chunk with section title
          flushChunk(hasContentSinceSection) // Add overlap if mid-section
          currentAcc = resetAccumulatedChunk()
          currentAcc.text = appendLine(currentAcc.text, paraText)
          currentAcc.tokens += paraTokens
          currentAcc.nodes.push(paraNode)  // Track the node
          hasContentSinceSection = true
        }
        break
      }

      case "table": {
        const tableNode = node as SemanticTableNode

        // Tables are atomic - flush current first (no overlap for table boundaries)
        if (currentAcc && currentAcc.text !== getSectionTitleText()) {
          flushChunk(hasContentSinceSection)
        }

        // Handle table with header repetition if needed
        const sectionTitle = getSectionTitleText()
        const tablePages = getUnique(
          (tableNode.pageNumbers && tableNode.pageNumbers.length > 0)
            ? tableNode.pageNumbers
            : [tableNode.pageNo].filter((p): p is number => p !== undefined)
        )
        const tableRefs = tableNode.sourceRefs
        const header = tableNode.header
        const rows = tableNode.rows

        if (!header || !rows || rows.length === 0) {
          // Simple table (no structured data), create single chunk
          const tableText = tableNode.text
          const text = sectionTitle + "\n" + tableText
          chunks.push({
            id: generateChunkId(chunkIndex++),
            text,
            metadata: {
              index: chunkIndex - 1,
              pageNumbers: tablePages,
              sectionPaths: [[...currentSectionPath]],
              labels: ["section", "table"],
              tokenCount: estimateTokens(text),
              charCount: text.length,
            },
            refs: getUnique(tableRefs),
          })
        } else {
          // Structured table with header - split if needed with header repetition
          const headerText = header.join(" | ")
          const sectionTokens = estimateTokens(sectionTitle)
          const headerTokens = estimateTokens(headerText)
          const baseTokens = sectionTokens + headerTokens

          let currentRows: string[][] = []
          let currentTokens = baseTokens

          for (const row of rows) {
            const rowText = row.join(" | ")
            const rowTokens = estimateTokens(rowText)

            // Check if this single row is too large
            if (rowTokens > maxTokens - sectionTokens) {
              // Flush any accumulated rows first
              if (currentRows.length > 0) {
                chunks.push(buildTableChunk(sectionTitle, headerText, currentRows, tablePages, tableRefs, chunkIndex++))
                currentRows = []
                currentTokens = baseTokens
              }
              // Handle oversized row - put in its own chunk
              chunks.push(buildTableChunk(sectionTitle, headerText, [row], tablePages, tableRefs, chunkIndex++))
              continue
            }

            // Check if adding this row would exceed limit
            if (currentTokens + rowTokens <= maxTokens) {
              currentRows.push(row)
              currentTokens += rowTokens
            } else {
              // Flush current batch
              if (currentRows.length > 0) {
                chunks.push(buildTableChunk(sectionTitle, headerText, currentRows, tablePages, tableRefs, chunkIndex++))
              }
              // Start new batch with this row
              currentRows = [row]
              currentTokens = baseTokens + rowTokens
            }
          }

          // Flush remaining rows
          if (currentRows.length > 0) {
            chunks.push(buildTableChunk(sectionTitle, headerText, currentRows, tablePages, tableRefs, chunkIndex++))
          }
        }

        // Reset for next content (tables break the overlap chain)
        currentAcc = resetAccumulatedChunk()
        hasContentSinceSection = false
        lastOriginalText = "" // Clear overlap context after table
        break
      }

      case "image": {
        const imageNode = node as SemanticImageNode

        // Images are treated as atomic units and merged with content
        const imageText = imageNode.description || "[image]"
        const imageTokens = estimateTokens(imageText)
        const imagePages = getUnique(
          (imageNode.pageNumbers && imageNode.pageNumbers.length > 0)
            ? imageNode.pageNumbers
            : [imageNode.pageNo].filter((p): p is number => p !== undefined)
        )
        const imageRefs = imageNode.sourceRefs

        // Initialize accumulator if needed
        if (!currentAcc) {
          currentAcc = resetAccumulatedChunk()
        }

        const currentTokens = currentAcc.tokens

        if (currentTokens + imageTokens <= maxTokens) {
          // Add to current chunk
          currentAcc.text = appendLine(currentAcc.text, imageText)
          currentAcc.tokens += imageTokens
          currentAcc.nodes.push(imageNode)  // Track the node
          hasContentSinceSection = true
        } else {
          // Flush and start new chunk
          flushChunk(hasContentSinceSection) // Add overlap if mid-section
          currentAcc = resetAccumulatedChunk()
          currentAcc.text = appendLine(currentAcc.text, imageText)
          currentAcc.tokens += imageTokens
          currentAcc.nodes.push(imageNode)  // Track the node
          hasContentSinceSection = true
        }
        break
      }

      case "comment": {
        // Comments are attached to current context (appended to current chunk)
        // The iterator already wrapped the text with [COMMENT: ...]
        const commentNode = node as { text: string; pageNumbers?: number[]; pageNo?: number; sourceRefs: string[] }
        const commentText = commentNode.text
        const commentTokens = estimateTokens(commentText)

        // Initialize accumulator if needed
        if (!currentAcc) {
          currentAcc = resetAccumulatedChunk()
        }

        const currentTokens = currentAcc.tokens

        if (currentTokens + commentTokens <= maxTokens) {
          // Add to current chunk
          currentAcc.text = appendLine(currentAcc.text, commentText)
          currentAcc.tokens += commentTokens
          // Track comment node
          currentAcc.nodes.push(node as SemanticNode)
          hasContentSinceSection = true
        } else {
          // Flush and start new chunk with comment
          flushChunk(hasContentSinceSection) // Add overlap if mid-section
          currentAcc = resetAccumulatedChunk()
          currentAcc.text = appendLine(currentAcc.text, commentText)
          currentAcc.tokens += commentTokens
          // Track comment node
          currentAcc.nodes.push(node as SemanticNode)
          hasContentSinceSection = true
        }
        break
      }
    }
  }

  // Flush remaining content
  if (currentAcc && currentAcc.text !== getSectionTitleText()) {
    flushChunk(false) // No overlap for final chunk
  }

  // If no chunks were created but we have content, create one
  if (chunks.length === 0 && currentAcc) {
    const sectionTitle = getSectionTitleText()
    if (currentAcc.text !== sectionTitle) {
      chunks.push(buildChunk(currentAcc))
    }
  }

  return chunks
}
