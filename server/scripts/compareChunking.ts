#!/usr/bin/env bun
/**
 * Comparison test: Old graph-based vs New semantic stream-based chunking
 */

import { readFileSync } from "fs"
import { resolve } from "path"
import { convertDoclingToGraph } from "../lib/documentGraph"
import { chunkGraph } from "../lib/chunkGraph"
import { processDoclingDocument } from "../lib"

const API_URL = "http://localhost:8000/parse"
const DEFAULT_TIMEOUT_MS = 300000

interface DoclingResponse {
  document?: any
}

async function testComparison(pdfPath: string): Promise<void> {
  const resolvedPath = resolve(pdfPath)

  console.log(`\n📊 COMPARISON TEST`)
  console.log(`   File: ${resolvedPath}`)

  // Read and parse PDF
  let pdfBuffer: Buffer
  try {
    pdfBuffer = readFileSync(resolvedPath)
  } catch (error) {
    console.error(`\n❌ Error reading file: ${error}`)
    process.exit(1)
  }

  // Send to Docling
  console.log(`\n⏳ Parsing with Docling...`)
  let doclingResponse: DoclingResponse
  try {
    const formData = new FormData()
    formData.append("file", new Blob([pdfBuffer]), "document.pdf")

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
    console.log(`✅ Docling parsing complete`)
  } catch (error) {
    console.error(`\n❌ Error: ${error}`)
    process.exit(1)
  }

  // OLD SYSTEM
  console.log(`\n--- OLD SYSTEM (Graph-based) ---`)
  const graph = convertDoclingToGraph(doclingResponse.document, resolvedPath)
  const oldChunks = chunkGraph(graph, { maxTokens: 512 })

  const oldTotalTokens = oldChunks.reduce((sum, c) => sum + Math.ceil(c.text.length / 4), 0)
  console.log(`Chunks: ${oldChunks.length}`)
  console.log(`Total tokens: ${oldTotalTokens}`)
  console.log(`Avg tokens/chunk: ${Math.round(oldTotalTokens / oldChunks.length)}`)

  // NEW SYSTEM
  console.log(`\n--- NEW SYSTEM (Semantic Stream) ---`)
  const newChunks = processDoclingDocument(doclingResponse.document, {
    maxTokens: 512,
    minTokens: 50,
  })

  const newTotalTokens = newChunks.reduce((sum, c) => sum + c.metadata.tokenCount, 0)
  console.log(`Chunks: ${newChunks.length}`)
  console.log(`Total tokens: ${newTotalTokens}`)
  console.log(`Avg tokens/chunk: ${Math.round(newTotalTokens / newChunks.length)}`)

  // COMPARISON
  console.log(`\n--- COMPARISON ---`)
  const chunkDiff = newChunks.length - oldChunks.length
  const tokenDiff = newTotalTokens - oldTotalTokens

  console.log(`Chunk count: ${chunkDiff > 0 ? "+" : ""}${chunkDiff} (${Math.abs(Math.round((chunkDiff / oldChunks.length) * 100))}% change)`)
  console.log(`Token count: ${tokenDiff > 0 ? "+" : ""}${tokenDiff} (${Math.abs(Math.round((tokenDiff / oldTotalTokens) * 100))}% change)`)

  // Show sample chunks
  console.log(`\n--- SAMPLE CHUNKS (New System) ---`)
  newChunks.slice(0, 3).forEach((chunk, i) => {
    console.log(`\nChunk ${i + 1}:`)
    console.log(`  Section: ${chunk.metadata.sectionPath.join(" > ") || "ROOT"}`)
    console.log(`  Tokens: ${chunk.metadata.tokenCount}`)
    console.log(`  Preview: ${chunk.text.substring(0, 100)}...`)
  })

  // Check for content in problematic section (5)
  console.log(`\n--- SECTION 5 CHECK ---`)
  const section5Old = oldChunks.find(c => c.metadata.section_path.some(s => s.includes("5") || s.includes("Pre-requisites")))
  const section5New = newChunks.find(c => c.metadata.sectionPath.some(s => s.includes("5") || s.includes("Pre-requisites")))

  if (section5Old) {
    console.log(`Old system - Section 5 tokens: ${Math.ceil(section5Old.text.length / 4)}`)
    console.log(`Preview: ${section5Old.text.substring(0, 80)}...`)
  } else {
    console.log(`Old system - Section 5: NOT FOUND ❌`)
  }

  if (section5New) {
    console.log(`New system - Section 5 tokens: ${section5New.metadata.tokenCount}`)
    console.log(`Preview: ${section5New.text.substring(0, 80)}...`)
  } else {
    console.log(`New system - Section 5: NOT FOUND ❌`)
  }

  console.log(`\n✨ Test complete!`)
}

// Main
async function main() {
  const pdfPath = process.argv[2]

  if (!pdfPath) {
    console.error("Usage: bun run scripts/compareChunking.ts <pdf-path>")
    console.error("\nExample:")
    console.error("  bun run scripts/compareChunking.ts ~/Documents/test.pdf")
    process.exit(1)
  }

  await testComparison(pdfPath)
}

main().catch(console.error)