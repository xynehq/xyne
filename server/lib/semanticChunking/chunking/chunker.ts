/**
 * Main chunking implementation
 * Converts semantic node stream to token-aware chunks
 * Now with inline image processing
 */

import type { SemanticNode, SemanticSectionNode, SemanticParagraphNode, SemanticTableNode, SemanticImageNode } from "../semantic/types"
import type { Chunk, ChunkingOptions, ChunkingResult } from "./types"
import { estimateTokens, splitIntoSentences, getUnique, generateChunkId, getOverlapText } from "./utils"
import { processImageNode, type ProcessedImage } from "../docling/imageProcessor"
import { DeferredImageDescriptionBatch } from "../../deferredImageDescription"
import { randomUUID } from "crypto"
import { type ChunkMetadata } from "@/types"

interface AccumulatedChunk {
  text: string
  tokens: number
  nodes: SemanticNode[]
}

interface PendingImage {
  seq: number
  node: SemanticImageNode
}

interface ImageProcessingState {
  batch: DeferredImageDescriptionBatch
  docId: string
  describeImages: boolean
  seqToHash: Map<number, string>
  pendingImages: PendingImage[]
}

/**
 * Main chunking function - converts semantic stream to chunks
 * Now async to handle inline image processing
 */
export async function chunkSemanticStream(
  nodes: Iterable<SemanticNode>,
  options: ChunkingOptions = {}
): Promise<ChunkingResult> {
  const {
    maxTokens = 512,
    minTokens = 50,
    targetTokens: userTargetTokens,
    docId = randomUUID(),
    describeImages = true,
  } = options

  const targetTokens = userTargetTokens ?? Math.floor((minTokens + maxTokens) / 2)
  const overlapSentences = 2
  const maxOverlapTokens = Math.floor(maxTokens * 0.15)

  const chunks: Chunk[] = []
  
  // Global sequence counter for chunks and images (like pdfChunks)
  let globalSeq = 0

  // Current section state
  let currentSectionPath: string[] = []
  let currentAcc: AccumulatedChunk | null = null
  let hasContentSinceSection = false
  let lastOriginalText = ""

  // Image processing state
  const imageState: ImageProcessingState = {
    batch: new DeferredImageDescriptionBatch(),
    docId,
    describeImages,
    seqToHash: new Map(),
    pendingImages: [],
  }

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


  function derivePerPageBBoxes(nodes: SemanticNode[]): { page: number; l: number; t: number; r: number; b: number }[] | undefined {
    const pageMap = new Map<number, { l: number; t: number; r: number; b: number }>()

    for (const node of nodes) {
      const nodeBboxes = (node as { bboxes?: { page: number; l: number; t: number; r: number; b: number }[] }).bboxes
      if (nodeBboxes && nodeBboxes.length > 0) {
        for (const { page, l, t, r, b } of nodeBboxes) {
          const existing = pageMap.get(page)
          if (!existing) {
            pageMap.set(page, { l, t, r, b })
          } else {
            existing.l = Math.min(existing.l, l)
            existing.t = Math.min(existing.t, t)
            existing.r = Math.max(existing.r, r)
            existing.b = Math.max(existing.b, b)
          }
        }
        continue
      }

      if (!node.bbox) continue

      const pages = node.pageNumbers?.length
        ? node.pageNumbers
        : node.pageNo !== undefined
          ? [node.pageNo]
          : []

      for (const page of pages) {
        const existing = pageMap.get(page)
        if (!existing) {
          pageMap.set(page, { ...node.bbox })
        } else {
          existing.l = Math.min(existing.l, node.bbox.l)
          existing.t = Math.min(existing.t, node.bbox.t)
          existing.r = Math.max(existing.r, node.bbox.r)
          existing.b = Math.max(existing.b, node.bbox.b)
        }
      }
    }

    if (pageMap.size === 0) return undefined

    return Array.from(pageMap.entries()).map(([page, bbox]) => ({
      page,
      ...bbox
    }))
  }

  /**
   * Build final chunk from accumulated content
   * All metadata derived from nodes (source of truth)
   */
  function buildChunk(acc: AccumulatedChunk): Chunk {
    return {
      id: generateChunkId(globalSeq),
      text: acc.text,
      metadata: {
        chunk_index: globalSeq,
        page_numbers: derivePageNumbers(acc.nodes),
        block_labels: deriveLabels(acc.nodes),
        bboxes: derivePerPageBBoxes(acc.nodes),
      },
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
    globalSeq++  // Increment global sequence for text chunks
    
    // Store ORIGINAL text for next overlap (not the mutated version with overlap)
    lastOriginalText = originalText
    
    currentAcc = null
    hasContentSinceSection = false
  }

  /**
   * Extract base64 data from data URI
   */
  function extractBase64FromUri(uri: string): { mime: string; data: Buffer } | null {
    const match = uri.match(/^data:([^;]+);base64,(.+)$/)
    if (!match) return null
    const [, mime, base64] = match
    return { mime, data: Buffer.from(base64, "base64") }
  }

  /**
   * Process image inline - save to disk and register for description
   */
  async function processImageInline(imageNode: SemanticImageNode, seq: number): Promise<ProcessedImage | null> {
    if (!imageNode.imageUri) {
      return null
    }

    const extracted = extractBase64FromUri(imageNode.imageUri)
    if (!extracted) {
      return null
    }

    // Process and save image with metadata
    const processedImage = await processImageNode({
      seq: seq,
      imageUri: imageNode.imageUri,
      mimetype: imageNode.mimetype,
      width: imageNode.width,
      height: imageNode.height,
    }, {
      docId: imageState.docId,
      describeImages: imageState.describeImages,
      batch: imageState.batch,
    })

    return processedImage
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
          
          const bboxes = tableNode?.bbox
            ? tablePages.map(page => ({ page, ...tableNode.bbox! }))
            : undefined
          
          const seq = globalSeq++
          chunks.push({
            id: generateChunkId(seq),
            text,
            metadata: {
              chunk_index: seq,
              page_numbers: tablePages,
              block_labels: ["section", "table"],
              bboxes,
            },
          })
        } else {
          // Structured table with header - split if needed with header repetition
          const headerText = header.join(" | ")
          const sectionTokens = estimateTokens(sectionTitle)
          const headerTokens = estimateTokens(headerText)
          const baseTokens = sectionTokens + headerTokens

          let currentRows: string[][] = []
          let currentTokens = baseTokens

          const bboxes = tableNode?.bbox
            ? tablePages.map(page => ({ page, ...tableNode.bbox! }))
            : undefined

          for (const row of rows) {
            const rowText = row.join(" | ")
            const rowTokens = estimateTokens(rowText)

            // Check if this single row is too large
            if (rowTokens > maxTokens - sectionTokens) {
              // Flush any accumulated rows first
              if (currentRows.length > 0) {
                const chunkText = [sectionTitle, headerText, ...currentRows.map(r => r.join(" | "))].join("\n")
                chunks.push({
                  id: generateChunkId(globalSeq),
                  text: chunkText,
                  metadata: {
                    chunk_index: globalSeq++,
                    page_numbers: tablePages,
                    block_labels: ["section", "table"],
                    bboxes,
                  },
                })
                currentRows = []
                currentTokens = baseTokens
              }
              // Handle oversized row - put in its own chunk
              const chunkText = [sectionTitle, headerText, row.join(" | ")].join("\n")
              chunks.push({
                id: generateChunkId(globalSeq),
                text: chunkText,
                metadata: {
                  chunk_index: globalSeq++,
                  page_numbers: tablePages,
                  block_labels: ["section", "table"],
                  bboxes,
                },
              })
              continue
            }

            // Check if adding this row would exceed limit
            if (currentTokens + rowTokens <= maxTokens) {
              currentRows.push(row)
              currentTokens += rowTokens
            } else {
              // Flush current batch
              if (currentRows.length > 0) {
                const chunkText = [sectionTitle, headerText, ...currentRows.map(r => r.join(" | "))].join("\n")
                chunks.push({
                  id: generateChunkId(globalSeq),
                  text: chunkText,
                  metadata: {
                    chunk_index: globalSeq++,
                    page_numbers: tablePages,
                    block_labels: ["section", "table"],
                    bboxes,
                  },
                })
              }
              // Start new batch with this row
              currentRows = [row]
              currentTokens = baseTokens + rowTokens
            }
          }

          // Flush remaining rows
          if (currentRows.length > 0) {
            const chunkText = [sectionTitle, headerText, ...currentRows.map(r => r.join(" | "))].join("\n")
            chunks.push({
              id: generateChunkId(globalSeq),
              text: chunkText,
              metadata: {
                chunk_index: globalSeq++,
                page_numbers: tablePages,
                block_labels: ["section", "table"],
                bboxes,
              },
            })
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
        const seq = globalSeq++

        // Process image inline - save to disk and register for description
        const processed = await processImageInline(imageNode, seq)

        if (processed) {
          imageState.seqToHash.set(seq, processed.imageHash)

          imageState.pendingImages.push({
            seq,
            node: imageNode,
          })
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

  // Flush image descriptions at the end
  if (imageState.describeImages && imageState.seqToHash.size > 0) {
    await imageState.batch.flushDescribeQueue(true)
    
    // Build image chunks after LLM flush
    const image_chunks: string[] = []
    const image_chunk_pos: number[] = []
    const image_chunks_map: ChunkMetadata[] = []
    
    for (const img of imageState.pendingImages) {
      const hash = imageState.seqToHash.get(img.seq)
      if (!hash) continue
      
      // Placeholder (will be replaced by applyResolvedDescriptions)
      image_chunks.push(imageState.batch["placeholderText"] || "This is an image.")
      image_chunk_pos.push(img.seq)
      
      image_chunks_map.push({
        chunk_index: img.seq,
        page_numbers: derivePageNumbers([img.node]),
        block_labels: ["image"],
        bboxes: derivePerPageBBoxes([img.node]),
      })
    }
    
    // Apply resolved descriptions
    imageState.batch.applyResolvedDescriptions(image_chunks, image_chunk_pos, imageState.seqToHash)
    
    // Strip rejected image rows
    imageState.batch.stripRejectedImageRows(image_chunks, image_chunk_pos, imageState.seqToHash, image_chunks_map)
    
    // Build text_chunks_map
    const text_chunk_pos: number[] = chunks.map(c => c.metadata.chunk_index)
    const text_chunks_map: ChunkMetadata[] = chunks.map(c => (c.metadata))
    
    return {
      text_chunks: chunks.map(c => c.text),
      image_chunks,
      text_chunk_pos,
      image_chunk_pos,
      text_chunks_map,
      image_chunks_map,
    }
  }
  
  // No images to process - return text chunks only
  const text_chunk_pos: number[] = chunks.map(c => c.metadata.chunk_index)
  const text_chunks_map = chunks.map(c => (c.metadata))
  
  return {
    text_chunks: chunks.map(c => c.text),
    image_chunks: [],
    text_chunk_pos,
    image_chunk_pos: [],
    text_chunks_map,
    image_chunks_map: [],
  }
}
