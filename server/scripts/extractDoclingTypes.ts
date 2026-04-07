#!/usr/bin/env bun
/**
 * Extract all unique node types from Docling output
 *
 * Usage: bun run scripts/extractDoclingTypes.ts <pdf-path>
 *
 * This script analyzes parsed Docling JSON to discover all node types
 * used in real documents, helping us build a complete type mapping.
 */

import { readFileSync } from "fs"
import { resolve } from "path"

const API_URL = "http://localhost:8000/parse"
const DEFAULT_TIMEOUT_MS = 300000

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
      data?: any
      prov?: Array<{ page_no?: number }>
    }>
    pictures?: Array<{
      self_ref: string
      prov?: Array<{ page_no?: number }>
    }>
  }
}

async function extractTypes(pdfPath: string): Promise<void> {
  const resolvedPath = resolve(pdfPath)

  console.log(`\n📄 Analyzing Docling types`)
  console.log(`   File: ${resolvedPath}`)

  // Read PDF file
  let pdfBuffer: Buffer
  try {
    pdfBuffer = readFileSync(resolvedPath)
    console.log(`   Size: ${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB`)
  } catch (error) {
    console.error(`\n❌ Error reading file: ${error}`)
    process.exit(1)
  }

  // Send to Docling service
  console.log(`\n⏳ Sending to Docling service (${API_URL})...`)

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
    console.log(`\n✅ Docling parsing complete`)
  } catch (error) {
    console.error(`\n❌ Error: ${error}`)
    process.exit(1)
  }

  // Save full Docling output
  const outputPath = resolvedPath.replace(/\.pdf$/i, ".parsed.json")
  const fs = await import("fs")
  fs.writeFileSync(outputPath, JSON.stringify(doclingResponse, null, 2))
  console.log(`💾 Full Docling output saved to: ${outputPath}`)

  // Extract all unique types
  const types = new Set<string>()
  const doc = doclingResponse.document

  if (doc?.texts) {
    for (const text of doc.texts) {
      if (text.label) {
        types.add(text.label)
      }
    }
  }

  if (doc?.tables) {
    types.add("table")
  }

  if (doc?.pictures) {
    types.add("picture")
  }

  // Show results
  console.log(`\n${"=".repeat(60)}`)
  console.log("UNIQUE NODE TYPES FOUND")
  console.log(`${"=".repeat(60)}`)

  const sortedTypes = Array.from(types).sort()
  console.log(`\nTotal unique types: ${sortedTypes.length}\n`)

  for (const type of sortedTypes) {
    // Count occurrences
    let count = 0
    if (doc?.texts) {
      count = doc.texts.filter((t) => t.label === type).length
    }
    if (type === "table" && doc?.tables) {
      count = doc.tables.length
    }
    if (type === "picture" && doc?.pictures) {
      count = doc.pictures.length
    }
    console.log(`  • ${type.padEnd(25)} (${count} instances)`)
  }

  // Show sample of each type
  console.log(`\n${"=".repeat(60)}`)
  console.log("SAMPLES (first occurrence of each type)")
  console.log(`${"=".repeat(60)}`)

  for (const type of sortedTypes) {
    console.log(`\n--- ${type.toUpperCase()} ---`)

    if (type === "table" && doc?.tables && doc.tables.length > 0) {
      console.log(`  Ref: ${doc.tables[0].self_ref}`)
      console.log(
        `  Has cells: ${doc.tables[0].data?.table_cells ? "yes" : "no"}`,
      )
    } else if (type === "picture" && doc?.pictures && doc.pictures.length > 0) {
      console.log(`  Ref: ${doc.pictures[0].self_ref}`)
    } else if (doc?.texts) {
      const sample = doc.texts.find((t) => t.label === type)
      if (sample) {
        const text = sample.text || "[no text]"
        console.log(`  Ref: ${sample.self_ref}`)
        console.log(
          `  Text: ${text.substring(0, 100)}${text.length > 100 ? "..." : ""}`,
        )
      }
    }
  }

  // Export types for use in mapping
  console.log(`\n${"=".repeat(60)}`)
  console.log("TYPE ARRAY (for mapping)")
  console.log(`${"=".repeat(60)}`)
  console.log(`\nconst doclingTypes = ${JSON.stringify(sortedTypes, null, 2)}`)

  console.log(`\n✨ Analysis complete!`)
}

// Main entry point
async function main() {
  const pdfPath = process.argv[2]

  if (!pdfPath) {
    console.error("Usage: bun run scripts/extractDoclingTypes.ts <pdf-path>")
    console.error("")
    console.error("Example:")
    console.error(
      "  bun run scripts/extractDoclingTypes.ts ~/Documents/paper.pdf",
    )
    process.exit(1)
  }

  await extractTypes(pdfPath)
}

main().catch(console.error)
