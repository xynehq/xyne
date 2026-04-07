#!/usr/bin/env bun
/**
 * Test script for semantic chunking
 *
 * Usage: bun run scripts/testChunkGraph.ts <pdf-path>
 *
 * This script:
 * 1. Reads a PDF file
 * 2. Sends it to Docling service (localhost:8000/parse)
 * 3. Processes Docling output with new semantic chunking pipeline
 * 4. Outputs enriched chunks for manual inspection
 */

import { readFileSync } from "fs"
import { resolve } from "path"
import { processDoclingDocument } from "../lib"
import type { DoclingDocument } from "../lib/semanticChunking/docling/types"

const API_URL = "http://localhost:8000/parse"
const DEFAULT_TIMEOUT_MS = 300000 // 5 minutes for model loading on first run

interface DoclingResponse {
  document?: {
    body?: {
      children?: Array<{ $ref: string }>
    }
    texts?: Array<{
      self_ref: string
      label: string
      text?: string
      level?: number
      prov?: Array<{ page_no?: number; bbox?: number[] }>
    }>
    tables?: Array<{
      self_ref: string
      data?: {
        table_cells?: Array<{
          text?: string
          start_row_offset_idx?: number
          start_col_offset_idx?: number
          row?: number
          col?: number
          column_header?: boolean
        }>
      }
      prov?: Array<{ page_no?: number }>
    }>
    pictures?: Array<{
      self_ref: string
      prov?: Array<{ page_no?: number }>
    }>
  }
}

interface EnrichedChunk {
  index: number
  text: string
  tokens: number
  charCount: number
  pages: number[]
  sectionPaths: string[][]
  labels: string[]
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function printChunk(chunk: EnrichedChunk, detailed: boolean = false): void {
  console.log(`\n${"=".repeat(60)}`)
  console.log(`CHUNK ${chunk.index}`)
  console.log(`${"=".repeat(60)}`)
  console.log(`Section: ${chunk.sectionPaths.map(sp => sp.join(" > ")).join(" | ") || "ROOT"}`)
  console.log(`Pages: ${chunk.pages.join(", ") || "none"}`)
  console.log(`Tokens: ${chunk.tokens} | Chars: ${chunk.charCount}`)
  console.log(`Labels: ${chunk.labels.join(", ")}`)

  if (detailed) {
    console.log(`\nContent:`)
    console.log("-".repeat(60))
    // Show first 800 chars, or full text if shorter
    const preview =
      chunk.text.length > 800
        ? chunk.text.substring(0, 800) + "\n... [truncated]"
        : chunk.text
    console.log(preview)
  } else {
    // Just show first line
    const firstLine = chunk.text.split("\n")[0]
    console.log(
      `\nPreview: ${firstLine.substring(0, 100)}${firstLine.length > 100 ? "..." : ""}`,
    )
  }
}

async function testSemanticChunking(pdfPath: string): Promise<void> {
  const resolvedPath = resolve(pdfPath)

  console.log(`\n📄 Testing Semantic Chunking`)
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
    formData.append("file", new Blob([fileBuffer]), `document.${extension}`)

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

    // Show document structure
    const doc = doclingResponse.document
    if (doc) {
      console.log(`   Texts: ${doc.texts?.length || 0} items`)
      console.log(`   Tables: ${doc.tables?.length || 0} items`)
      console.log(`   Pictures: ${doc.pictures?.length || 0} items`)
    }
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        console.error(
          `\n❌ Request timed out after ${DEFAULT_TIMEOUT_MS / 1000}s`,
        )
        console.error(`   The Docling service may still be loading models.`)
        console.error(`   Check server logs and try again in 2-3 minutes.`)
      } else if (
        error.message.includes("fetch failed") ||
        error.message.includes("ECONNREFUSED")
      ) {
        console.error(`\n❌ Cannot connect to Docling service at ${API_URL}`)
        console.error(`   Is the server running?`)
        console.error(`   Start it with: uvicorn app.main:app --reload`)
      } else {
        console.error(`\n❌ Error: ${error.message}`)
      }
    }
    process.exit(1)
  }

  // Process with new semantic chunking pipeline
  console.log(`\n⏳ Running semantic chunking pipeline...`)
  const doc = doclingResponse.document as unknown as DoclingDocument
  const chunks = processDoclingDocument(doc, { maxTokens: 400 })
  console.log(`\n✅ Chunking complete: ${chunks.length} chunks generated`)

  // Count document structure
  const sectionCount = doc.texts?.filter(t =>
    t.label === "section_header" || t.label === "title"
  ).length || 0
  const paragraphCount = doc.texts?.filter(t =>
    t.label === "text" || t.label === "paragraph"
  ).length || 0
  const tableCount = doc.tables?.length || 0
  const imageCount = doc.pictures?.length || 0

  console.log(`\n📊 Document structure:`)
  console.log(`   Sections: ${sectionCount}`)
  console.log(`   Paragraphs: ${paragraphCount}`)
  console.log(`   Tables: ${tableCount}`)
  console.log(`   Images: ${imageCount}`)

  // Enrich chunks
  const enrichedChunks: EnrichedChunk[] = chunks.map((chunk, idx) => ({
    index: idx,
    text: chunk.text,
    tokens: estimateTokens(chunk.text),
    charCount: chunk.text.length,
    pages: chunk.metadata.pageNumbers,
    sectionPaths: chunk.metadata.sectionPaths,
    labels: chunk.metadata.labels,
  }))

  // Source text totals (before semantic chunking)
  const sourceTexts = (doc.texts || [])
    .map((t) => t.text || "")
    .filter((t) => t.trim().length > 0)
  const sourceTextCharCount = sourceTexts.reduce((sum, t) => sum + t.length, 0)
  const sourceTextTokenCount = sourceTexts.reduce((sum, t) => sum + estimateTokens(t), 0)

  // Calculate statistics
  const totalTokens = enrichedChunks.reduce((sum, c) => sum + c.tokens, 0)
  const totalChars = enrichedChunks.reduce((sum, c) => sum + c.charCount, 0)
  const avgTokens = Math.round(totalTokens / enrichedChunks.length)
  const minTokens = Math.min(...enrichedChunks.map((c) => c.tokens))
  const maxTokens = Math.max(...enrichedChunks.map((c) => c.tokens))

  console.log(`\n${"=".repeat(60)}`)
  console.log("STATISTICS")
  console.log(`${"=".repeat(60)}`)
  console.log(`Total chunks: ${chunks.length}`)
  console.log(`Total tokens: ${totalTokens}`)
  console.log(`Average tokens/chunk: ${avgTokens}`)
  console.log(`Min tokens: ${minTokens} | Max tokens: ${maxTokens}`)

  // Show all chunks (summary view)
  console.log(`\n${"=".repeat(60)}`)
  console.log("ALL CHUNKS (Summary)")
  console.log(`${"=".repeat(60)}`)

  for (const chunk of enrichedChunks) {
    printChunk(chunk, false)
  }

  // Show first 3 chunks in detail
  console.log(`\n${"=".repeat(60)}`)
  console.log("DETAILED VIEW (First 3 chunks)")
  console.log(`${"=".repeat(60)}`)

  for (const chunk of enrichedChunks.slice(0, 3)) {
    printChunk(chunk, true)
  }

  // Quality checks
  console.log(`\n${"=".repeat(60)}`)
  console.log("QUALITY CHECKS")
  console.log(`${"=".repeat(60)}`)

  let issues: string[] = []

  // Check 1: Section context
  const missingSectionContext = enrichedChunks.filter(
    (c) => c.sectionPaths.length === 0 && !c.text.startsWith("ROOT"),
  )
  if (missingSectionContext.length > 0) {
    issues.push(
      `⚠️  ${missingSectionContext.length} chunks missing section context`,
    )
  } else {
    console.log(`✅ All chunks have section context`)
  }

  // Check 2: Chunk size distribution
  const oversizedChunks = enrichedChunks.filter((c) => c.tokens > 500)
  const undersizedChunks = enrichedChunks.filter((c) => c.tokens < 50)

  if (oversizedChunks.length > 0) {
    issues.push(`⚠️  ${oversizedChunks.length} oversized chunks (>500 tokens)`)
  }
  if (undersizedChunks.length > enrichedChunks.length * 0.3) {
    issues.push(`⚠️  ${undersizedChunks.length} very small chunks (<50 tokens)`)
  }
  if (
    oversizedChunks.length === 0 &&
    undersizedChunks.length <= enrichedChunks.length * 0.3
  ) {
    console.log(`✅ Chunk sizes look healthy`)
  }

  // Check 3: Section isolation
  const mixedSections = enrichedChunks.filter((c) => {
    const lines = c.text.split("\n")
    const sectionHeaders = lines.filter((l) => l.match(/^#+ /))
    return sectionHeaders.length > 1
  })
  if (mixedSections.length > 0) {
    issues.push(`⚠️  ${mixedSections.length} chunks may have mixed sections`)
  } else {
    console.log(`✅ No obvious section mixing detected`)
  }

  // Print issues
  if (issues.length > 0) {
    console.log(`\n⚠️  ISSUES FOUND:`)
    for (const issue of issues) {
      console.log(`   ${issue}`)
    }
  } else {
    console.log(`\n✅ All quality checks passed!`)
  }

  // Save full output to file
  const baseName = resolvedPath.split("/").pop()?.split(".")[0]
  const basePath = resolvedPath.slice(0, resolvedPath.lastIndexOf("/"))
  const outputPath = `${basePath}/${baseName}.chunks.json`
  const fs = await import("fs")
  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        metadata: {
          sourceFile: resolvedPath,
          totalChunks: chunks.length,
          sourceTextTokenCount,
          sourceTextCharCount,
          chunkedTextTokenCount: totalTokens,
          chunkedTextCharCount: totalChars,
          totalTokens, // backward compatibility
          avgTokens,
          minTokens,
          maxTokens,
        },
        chunks: enrichedChunks,
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
