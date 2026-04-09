#!/usr/bin/env bun
/**
 * Test script for semantic chunking with image processing
 *
 * Usage: bun run scripts/testChunkGraph.ts <pdf-path>
 *
 * This script:
 * 1. Reads a PDF file
 * 2. Sends it to Docling service (localhost:8000/parse)
 * 3. Processes Docling output with sync semantic iterator
 * 4. Processes images and builds chunk arrays
 * 5. Outputs enriched chunks with correct positional alignment
 */

import { readFileSync } from "fs"
import { resolve } from "path"
import { promises as fsPromises } from "fs"
import crypto from "crypto"
import { semanticIterator } from "../lib/semanticChunking/semantic"
import { chunkSemanticStream } from "../lib/semanticChunking/chunking/chunker"
import type { DoclingDocument } from "../lib/semanticChunking/docling/types"

const API_URL = "http://localhost:8000/parse"
const DEFAULT_TIMEOUT_MS = 300000

interface DoclingResponse {
  document?: DoclingDocument
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function testSemanticChunking(pdfPath: string): Promise<void> {
  const resolvedPath = resolve(pdfPath)

  console.log(`\n📄 Testing Semantic Chunking with Image Processing`)
  console.log(`   File: ${resolvedPath}`)

  // Read PDF file
  let fileBuffer: Buffer
  try {
    fileBuffer = readFileSync(resolvedPath)
    console.log(`   Size: ${formatBytes(fileBuffer.length)}`)
  } catch (error) {
    console.error(`\n❌ Error reading file: ${error}`)
    process.exit(1)
  }

  // Send to Docling service
  console.log(`\n⏳ Sending to Docling service (${API_URL})...`)
  console.log(`   (This may take 2-3 minutes on first run for model loading)`)

  let doclingResponse: DoclingResponse
  try {
    const formData = new FormData()
    const extension = resolvedPath.split(".").pop() || "pdf"
    formData.append("file", new Blob([new Uint8Array(fileBuffer)]), `document.${extension}`)

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

    const response = await fetch(API_URL, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`)
    }

    doclingResponse = await response.json()
    console.log(`\n✅ Docling parsing complete`)

    const doc = doclingResponse.document
    if (doc) {
      const textCount = (doc as any).texts?.length || 0
      const tableCount = (doc as any).tables?.length || 0
      const pictureCount = (doc as any).pictures?.length || 0
      console.log(`   Texts: ${textCount} items`)
      console.log(`   Tables: ${tableCount} items`)
      console.log(`   Pictures: ${pictureCount} items`)
    }
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        console.error(`\n❌ Request timed out after ${DEFAULT_TIMEOUT_MS / 1000}s`)
      } else if (error.message.includes("fetch failed")) {
        console.error(`\n❌ Cannot connect to Docling service at ${API_URL}`)
      } else {
        console.error(`\n❌ Error: ${error.message}`)
      }
    }
    process.exit(1)
  }

  // Generate document ID
  const docId = crypto.randomUUID()

  // Process with sync semantic iterator
  console.log(`\n⏳ Running sync semantic iterator...`)
  console.log(`   Doc ID: ${docId}`)

  const doc = doclingResponse.document!
  const nodes = [...semanticIterator(doc, { filterBodyOnly: true })]
  
  // Count images in nodes
  const imageCount = nodes.filter((n: any) => n.type === "image").length
  console.log(`\n✅ Iterator complete: ${nodes.length} nodes generated`)
  console.log(`   Images found: ${imageCount}`)

  // Process images and build chunks
  console.log(`\n⏳ Processing images and building chunks...`)
  const {
    text_chunks,
    image_chunks,
    text_chunk_pos,
    image_chunk_pos,
    text_chunks_map,
    image_chunks_map,
  } = await chunkSemanticStream(nodes, {
    docId,
    describeImages: true,
  })

  console.log(`✅ Image processing complete`)
  console.log(`   Text chunks: ${text_chunks.length}`)
  console.log(`   Image chunks: ${image_chunks.length}`)

  // Calculate statistics
  const totalTextTokens = text_chunks.reduce((sum, text) => sum + estimateTokens(text), 0)
  const totalImageTokens = image_chunks.reduce((sum, desc) => sum + estimateTokens(desc), 0)

  console.log(`\n${"=".repeat(60)}`)
  console.log("STATISTICS")
  console.log(`${"=".repeat(60)}`)
  console.log(`Document ID: ${docId}`)
  console.log(`Semantic nodes: ${nodes.length}`)
  console.log(`Text chunks: ${text_chunks.length}`)
  console.log(`Image chunks: ${image_chunks.length}`)
  // Enhanced statistics and validation
  console.log(`\n${"=".repeat(60)}`)
  console.log("VALIDATION")
  console.log(`${"=".repeat(60)}`)
  
  // Validate sequence ordering
  const allPositions = [...text_chunk_pos, ...image_chunk_pos].sort((a, b) => a - b)
  const expectedPositions = Array.from({length: allPositions.length}, (_, i) => i)
  const sequencesValid = JSON.stringify(allPositions) === JSON.stringify(expectedPositions)
  console.log(`Sequence continuity: ${sequencesValid ? '✅ PASS' : '❌ FAIL'}`)
  console.log(`  Positions: ${allPositions.slice(0, 10).join(", ")}${allPositions.length > 10 ? '...' : ''}`)
  
  // Check metadata completeness
  const textMetaComplete = text_chunks_map.every(m => 
    m.chunk_index !== undefined && 
    m.page_numbers !== undefined && 
    m.block_labels !== undefined
  )
  const imageMetaComplete = image_chunks_map.every(m => 
    m.chunk_index !== undefined && 
    m.page_numbers !== undefined && 
    m.block_labels !== undefined &&
    m.image_path !== undefined
  )
  console.log(`Text metadata: ${textMetaComplete ? '✅ Complete' : '❌ Incomplete'}`)
  console.log(`Image metadata: ${imageMetaComplete ? '✅ Complete' : '❌ Incomplete'}`)
  
  // Bbox validation
  const chunksWithBboxes = text_chunks_map.filter(m => m.bboxes && m.bboxes.length > 0).length
  const chunksWithoutBboxes = text_chunks_map.length - chunksWithBboxes
  console.log(`\nBounding Box Coverage:`)
  console.log(`  With bboxes: ${chunksWithBboxes}/${text_chunks_map.length} chunks`)
  console.log(`  Without bboxes: ${chunksWithoutBboxes}/${text_chunks_map.length} chunks`)
  
  // Show bbox samples
  if (chunksWithBboxes > 0) {
    const sampleWithBbox = text_chunks_map.find(m => m.bboxes && m.bboxes.length > 0)
    if (sampleWithBbox) {
      console.log(`  Sample bbox: ${JSON.stringify(sampleWithBbox.bboxes![0])}`)
    }
  }
  
  // Check which chunk types have bboxes
  const sectionChunksWithBboxes = text_chunks_map.filter(m => 
    m.block_labels?.includes('section') && m.bboxes?.length
  ).length
  const tableChunksWithBboxes = text_chunks_map.filter(m => 
    m.block_labels?.includes('table') && m.bboxes?.length
  ).length
  const paragraphChunksWithBboxes = text_chunks_map.filter(m => 
    m.block_labels?.includes('paragraph') && m.bboxes?.length
  ).length
  console.log(`\nBbox by type:`)
  console.log(`  Sections: ${sectionChunksWithBboxes}`)
  console.log(`  Tables: ${tableChunksWithBboxes}`)
  console.log(`  Paragraphs: ${paragraphChunksWithBboxes}`)
  
  // Interleaving check
  let textIdx = 0
  let imageIdx = 0
  const interleavePattern: string[] = []
  for (let i = 0; i < allPositions.length; i++) {
    if (textIdx < text_chunk_pos.length && text_chunk_pos[textIdx] === i) {
      interleavePattern.push('T')
      textIdx++
    } else if (imageIdx < image_chunk_pos.length && image_chunk_pos[imageIdx] === i) {
      interleavePattern.push('I')
      imageIdx++
    }
  }
  console.log(`Interleave pattern: ${interleavePattern.slice(0, 20).join('')}${interleavePattern.length > 20 ? '...' : ''}`)
  console.log(`  (T=text, I=image)`)

  // Show sample outputs
  console.log(`\n${"=".repeat(60)}`)
  console.log("SAMPLE TEXT CHUNKS")
  console.log(`${"=".repeat(60)}`)

  for (let i = 0; i < Math.min(3, text_chunks.length); i++) {
    const text = text_chunks[i]
    const preview = text.length > 200 
      ? text.substring(0, 200) + "..." 
      : text
    console.log(`\n[${i}] Seq: ${text_chunk_pos[i]}, Pages: ${text_chunks_map[i]?.page_numbers?.join(", ") || "N/A"}`)
    console.log(`    Labels: ${text_chunks_map[i]?.block_labels?.join(", ")}`)
    console.log(`    ${preview}`)
  }

  if (image_chunks.length > 0) {
    console.log(`\n${"=".repeat(60)}`)
    console.log("SAMPLE IMAGE DESCRIPTIONS")
    console.log(`${"=".repeat(60)}`)

    for (let i = 0; i < Math.min(3, image_chunks.length); i++) {
      const preview = image_chunks[i].length > 200 
        ? image_chunks[i].substring(0, 200) + "..." 
        : image_chunks[i]
      console.log(`\n[${i}] Seq: ${image_chunk_pos[i]}, Pages: ${image_chunks_map[i]?.page_numbers?.join(", ") || "N/A"}`)
      console.log(`    Image: ${image_chunks_map[i]?.image_path?.split('/').pop()}`)
      console.log(`    Dimensions: ${image_chunks_map[i]?.dimensions?.width}x${image_chunks_map[i]?.dimensions?.height}`)
      console.log(`    ${preview}`)
    }
  }

  // Save output
  const baseName = resolvedPath.split("/").pop()?.split(".")[0]
  const basePath = resolvedPath.slice(0, resolvedPath.lastIndexOf("/"))
  const outputPath = `${basePath}/${baseName}.chunks.json`

  await fsPromises.writeFile(
    outputPath,
    JSON.stringify(
      {
        metadata: {
          sourceFile: resolvedPath,
          docId,
          totalNodes: nodes.length,
          textChunks: text_chunks.length,
          imageChunks: image_chunks.length,
          totalTextTokens,
          totalImageTokens,
        },
        text_chunks,
        image_chunks,
        text_chunk_pos,
        image_chunk_pos,
        text_chunks_map,
        image_chunks_map,
      },
      null,
      2,
    ),
  )

  console.log(`\n💾 Full output saved to: ${outputPath}`)
  console.log(`\n✨ Test complete!`)
}

// Main entry point
async function main() {
  const pdfPath = process.argv[2]

  if (!pdfPath) {
    console.error("Usage: bun run scripts/testChunkGraph.ts <pdf-path>")
    console.error("")
    console.error("Example:")
    console.error("  bun run scripts/testChunkGraph.ts ~/Documents/sample.pdf")
    process.exit(1)
  }

  await testSemanticChunking(pdfPath)
}

main().catch(console.error)
