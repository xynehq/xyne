import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Define interfaces for the different schema types
interface BaseFields {
  type: "file" | "email" | "slack" | "event"
  docId: string
  workId: string
  timestamp: number
}

interface FileFields extends BaseFields {
  type: "file"
  chunks: string[]
}

interface EmailFields extends BaseFields {
  type: "email"
  chunks: string[]
}

interface SlackFields extends BaseFields {
  type: "slack"
  text: string
}

interface EventFields extends BaseFields {
  type: "event"
  description: string
}

interface JsonlRecord {
  put: {
    id: string
  }
  source: string
  fields: FileFields | EmailFields | SlackFields | EventFields
}

interface ExtractedContent {
  docId: string
  type: string
  body: string
  timestamp: number
  workId: string
}

function extractBodyFromRecord(record: JsonlRecord): ExtractedContent {
  const { fields } = record
  let body: string

  switch (fields.type) {
    case "file":
    case "email":
      // For files and emails, body is in chunks array
      body = (fields as FileFields | EmailFields).chunks.join("\n\n")
      break

    case "slack":
      // For slack, body is in text field
      body = (fields as SlackFields).text
      break

    case "event":
      // For events, body is in description field
      body = (fields as EventFields).description
      break

    default:
      throw new Error(`Unknown type: ${(fields as any).type}`)
  }

  return {
    docId: fields.docId,
    type: fields.type,
    body: body,
    timestamp: fields.timestamp,
    workId: fields.workId,
  }
}

function extractBodiesFromJsonl(
  inputFilePath: string,
  outputFilePath: string,
): void {
  try {
    console.log(`📖 Reading JSONL file: ${inputFilePath}`)

    // Read the JSONL file
    const fileContent = fs.readFileSync(inputFilePath, "utf-8")
    const lines = fileContent.trim().split("\n")

    console.log(`📊 Found ${lines.length} records to process`)

    const extractedBodies: ExtractedContent[] = []
    let processedCount = 0
    let errorCount = 0

    // Process each line
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      try {
        const record: JsonlRecord = JSON.parse(line)
        const extracted = extractBodyFromRecord(record)
        extractedBodies.push(extracted)
        processedCount++

        if (processedCount % 10 === 0) {
          console.log(`✅ Processed ${processedCount} records...`)
        }
      } catch (error) {
        errorCount++
        console.error(`❌ Error processing line ${i + 1}:`, error)
      }
    }

    // Group by type for summary
    const typeStats = extractedBodies.reduce(
      (acc, item) => {
        acc[item.type] = (acc[item.type] || 0) + 1
        return acc
      },
      {} as Record<string, number>,
    )

    console.log("\n📈 Extraction Summary:")
    console.log(`  Total processed: ${processedCount}`)
    console.log(`  Errors: ${errorCount}`)
    console.log("  By type:")
    Object.entries(typeStats).forEach(([type, count]) => {
      console.log(`    ${type}: ${count} records`)
    })

    // Write to output JSON file
    const outputData = {
      metadata: {
        extractedAt: new Date().toISOString(),
        totalRecords: extractedBodies.length,
        typeBreakdown: typeStats,
        sourceFile: path.basename(inputFilePath),
      },
      bodies: extractedBodies,
    }

    fs.writeFileSync(
      outputFilePath,
      JSON.stringify(outputData, null, 2),
      "utf-8",
    )
    console.log(`\n💾 Extracted bodies saved to: ${outputFilePath}`)

    // Show sample of extracted content
    console.log("\n🔍 Sample extracted content:")
    extractedBodies.slice(0, 3).forEach((item, index) => {
      console.log(`\n  Sample ${index + 1} (${item.type}):`)
      console.log(`    DocId: ${item.docId}`)
      console.log(`    Body preview: ${item.body.substring(0, 100)}...`)
    })
  } catch (error) {
    console.error("❌ Fatal error:", error)
    process.exit(1)
  }
}

// Main execution
function main() {
  const inputFile = "work_simulation-20250912.jsonl"
  const outputFile = "extracted_bodies.json"

  const inputPath = path.join(__dirname, inputFile)
  const outputPath = path.join(__dirname, outputFile)

  // Check if input file exists
  if (!fs.existsSync(inputPath)) {
    console.error(`❌ Input file not found: ${inputPath}`)
    process.exit(1)
  }

  console.log("🚀 Starting JSONL body extraction...")
  console.log(`📁 Input: ${inputFile}`)
  console.log(`📁 Output: ${outputFile}`)
  console.log("")

  extractBodiesFromJsonl(inputPath, outputPath)

  console.log("\n✨ Extraction completed successfully!")
}

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}

export { extractBodiesFromJsonl }
export type { ExtractedContent }
