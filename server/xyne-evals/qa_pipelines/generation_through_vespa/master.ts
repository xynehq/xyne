import * as fs from "fs"
import * as path from "path"
import * as dotenv from "dotenv"
import { selector } from "./selector.ts"
import { DataStore } from "./dataStore.ts"

// Load environment variables
dotenv.config({ path: ".env" })

// Configuration
const VESPA_EXPORT_PATH = "xyne-evals/data/actual_data/vespa_export_v2.json"
const NUMBER_OF_GROUPS = 10 // Set this to how many groups you want to generate

interface VespaDocument {
  put: {
    id: string
  }
  source: string
  fields: {
    docId: string
    type: "file" | "email" | "slack" | "event"
    chunks?: string[]
    text?: string
    description?: string
    [key: string]: any
  }
}

/**
 * Extract all document IDs from vespa export file
 */
function extractDocIds(vespaExportPath: string): string[] {
  console.log("📖 Reading vespa export file...")

  try {
    const content = fs.readFileSync(vespaExportPath, "utf-8")
    const docIds: string[] = []

    // Check if file is JSON array format or JSONL format
    const trimmedContent = content.trim()
    if (trimmedContent.startsWith("[")) {
      // JSON array format
      console.log("📊 Processing JSON array format...")
      const documents = JSON.parse(content)

      if (!Array.isArray(documents)) {
        throw new Error("Expected JSON array but got different format")
      }

      console.log(
        `📊 Processing ${documents.length} documents from JSON array...`,
      )

      for (let i = 0; i < documents.length; i++) {
        try {
          const doc = documents[i]
          // Handle both vespa export format and search result format
          if (doc.fields?.docId) {
            docIds.push(doc.fields.docId)
          } else if (doc.put?.id && doc.fields?.docId) {
            docIds.push(doc.fields.docId)
          } else {
            console.warn(`⚠️  Document ${i + 1} missing docId field`)
          }
        } catch (error) {
          console.warn(`⚠️  Failed to process document ${i + 1}:`, error)
        }
      }
    } else {
      // JSONL format (original logic)
      console.log("📊 Processing JSONL format...")
      const lines = content.trim().split("\n")
      console.log(`📊 Processing ${lines.length} lines from vespa export...`)

      for (let i = 0; i < lines.length; i++) {
        try {
          const doc: VespaDocument = JSON.parse(lines[i])
          if (doc.fields?.docId) {
            docIds.push(doc.fields.docId)
          }
        } catch (error) {
          console.warn(`⚠️  Failed to parse line ${i + 1}:`, error)
        }
      }
    }

    console.log(`✅ Extracted ${docIds.length} document IDs`)
    return docIds
  } catch (error) {
    console.error("❌ Error reading vespa export file:", error)
    throw error
  }
}

/**
 * Create a map of docId to complete document objects
 */
function createDocumentMap(vespaExportPath: string): Map<string, any> {
  console.log("🗺️  Creating document map...")

  try {
    const content = fs.readFileSync(vespaExportPath, "utf-8")
    const documentMap = new Map<string, any>()

    // Check if file is JSON array format or JSONL format
    const trimmedContent = content.trim()
    if (trimmedContent.startsWith("[")) {
      // JSON array format
      console.log("📊 Creating document map from JSON array format...")
      const documents = JSON.parse(content)

      if (!Array.isArray(documents)) {
        throw new Error("Expected JSON array but got different format")
      }

      for (let i = 0; i < documents.length; i++) {
        try {
          const doc = documents[i]
          const docId = doc.fields?.docId

          if (docId) {
            let body = ""

            // Extract body based on document structure and available fields
            if (doc.fields.chunks_summary) {
              // For files with chunks_summary
              body = Array.isArray(doc.fields.chunks_summary)
                ? doc.fields.chunks_summary.join("\n\n")
                : doc.fields.chunks_summary
            } else if (doc.fields.chunks) {
              // For files with chunks array
              body = Array.isArray(doc.fields.chunks)
                ? doc.fields.chunks.join("\n\n")
                : doc.fields.chunks
            } else if (doc.fields.text) {
              // For slack messages or other text content
              body = doc.fields.text
            } else if (doc.fields.description) {
              // For events with description
              body = doc.fields.description
            } else if (doc.fields.subject) {
              // For emails with subject
              body = doc.fields.subject
            } else {
              // Fallback: try to extract meaningful content from various fields
              const meaningfulFields = ["title", "name", "filename", "subject"]
              const extractedContent = meaningfulFields
                .filter((field) => doc.fields[field])
                .map((field) => doc.fields[field])
                .join(". ")

              if (extractedContent) {
                body = extractedContent
              } else {
                console.warn(`⚠️  No extractable content for document ${docId}`)
                body = JSON.stringify(doc.fields).substring(0, 500) // Fallback to partial JSON
              }
            }

            // Store complete document with body included
            const documentWithBody = {
              ...doc,
              body: body.trim(),
            }

            documentMap.set(docId, documentWithBody)
          }
        } catch (error) {
          console.warn(
            `⚠️  Failed to process document ${i + 1} for document mapping:`,
            error,
          )
        }
      }
    } else {
      // JSONL format (original logic)
      console.log("📊 Creating document map from JSONL format...")
      const lines = content.trim().split("\n")

      for (let i = 0; i < lines.length; i++) {
        try {
          const doc: VespaDocument = JSON.parse(lines[i])
          const docId = doc.fields?.docId

          if (docId) {
            let body = ""

            // Extract body based on document type
            switch (doc.fields.type) {
              case "file":
              case "email":
                body = doc.fields.chunks?.join("\n\n") || ""
                break
              case "slack":
                body = doc.fields.text || ""
                break
              case "event":
                body = doc.fields.description || ""
                break
              default:
                console.warn(`⚠️  Unknown document type: ${doc.fields.type}`)
                body = JSON.stringify(doc.fields)
            }

            // Store complete document with body included
            const documentWithBody = {
              ...doc,
              body: body.trim(),
            }

            documentMap.set(docId, documentWithBody)
          }
        } catch (error) {
          console.warn(
            `⚠️  Failed to parse line ${i + 1} for document mapping:`,
            error,
          )
        }
      }
    }

    console.log(`✅ Created document map with ${documentMap.size} entries`)
    return documentMap
  } catch (error) {
    console.error("❌ Error creating document map:", error)
    throw error
  }
}

/**
 * Load document data into DataStore for generator
 */
function loadDataIntoStore(vespaExportPath: string): void {
  console.log("📦 Loading data into DataStore...")

  const content = fs.readFileSync(vespaExportPath, "utf-8")
  const dataStore = DataStore.getInstance()
  dataStore.loadData(content)

  console.log("✅ Data loaded into DataStore")
}

/**
 * Main execution function - simplified to just data loading and selector calling
 */
async function main() {
  console.log("=".repeat(80))
  console.log("🎯 VESPA-BASED QA GENERATION PIPELINE - FIRE-AND-FORGET MODE")
  console.log("=".repeat(80))

  try {
    const vespaExportPath = path.resolve(VESPA_EXPORT_PATH)

    // Check if vespa export file exists
    if (!fs.existsSync(vespaExportPath)) {
      throw new Error(`Vespa export file not found: ${vespaExportPath}`)
    }

    console.log(`📁 Using vespa export: ${vespaExportPath}`)
    console.log(`👥 Number of groups: ${NUMBER_OF_GROUPS}`)
    console.log("")

    // Step 1: Load data once for all groups
    console.log("📦 INITIALIZATION - Loading shared data for all groups...")

    // Extract all document IDs (once)
    const allDocIds = extractDocIds(vespaExportPath)
    if (allDocIds.length === 0) {
      throw new Error("No document IDs found in vespa export")
    }

    // Create document map (once)
    const documentMap = createDocumentMap(vespaExportPath)

    // Load data into DataStore for generator (once)
    loadDataIntoStore(vespaExportPath)

    console.log("✅ Shared data loaded successfully")
    console.log("")

    // Step 2: Call selector with number of groups (fire-and-forget)
    console.log(`🚀 Starting selector for ${NUMBER_OF_GROUPS} groups...`)
    console.log(
      "📋 Processing will continue asynchronously with progressive saving",
    )
    console.log("")

    await selector(allDocIds, documentMap, NUMBER_OF_GROUPS)

    console.log("")
    console.log("=".repeat(80))
    console.log("✅ MASTER COMPLETED - All groups processed by selector")
    console.log("=".repeat(80))
  } catch (error) {
    console.error("")
    console.error("=".repeat(80))
    console.error("❌ MASTER PIPELINE FAILED")
    console.error("=".repeat(80))
    console.error("Error:", error)
    process.exit(1)
  }
}

// Run if this file is executed directly
if (require.main === module) {
  main()
}

export { main, extractDocIds, createDocumentMap, loadDataIntoStore }
