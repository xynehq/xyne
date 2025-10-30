import * as fs from "fs/promises"
import * as path from "path"
import { fileURLToPath } from "url"
import type { QAItem } from "./types"

// ES module equivalent of __dirname for compatibility
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export async function evaluator(results: any[], docIds: Set<string>) {
  console.log("📊 Starting evaluator for vespa-generated Q&A pairs...")
  console.log(`🔍 Received ${results.length} results to evaluate`)

  // Note: No confidence filtering in new structure - all results are processed
  console.log(
    `✅ Processing all ${results.length} items (no confidence filtering in new structure)`,
  )

  // Enrich results with additional metadata (Citations already added by generator)
  const enrichedResults = results.map((item) => ({
    ...item,
    source: "vespa_search",
    generatedAt: new Date().toISOString(),
  }))

  // Prepare output path
  const outputPath =
    "/Users/arshith.balaraju/Desktop/xyne/server/xyne-evals/data/qa_gen_from_actual/qa_output_actual_v1.json"

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath)
  try {
    await fs.mkdir(outputDir, { recursive: true })
  } catch (error) {
    console.warn("⚠️  Could not create output directory:", error)
  }

  // Load existing data if any
  let existing: any[] = []
  try {
    const data = await fs.readFile(outputPath, "utf-8")
    const parsed = JSON.parse(data)
    // Handle both old format (with metadata) and new format (direct array)
    if (Array.isArray(parsed)) {
      existing = parsed
    } else if (parsed.qaPairs && Array.isArray(parsed.qaPairs)) {
      existing = parsed.qaPairs // Extract from old format
    } else {
      existing = []
    }
  } catch (e) {
    // File does not exist or is invalid, start fresh
    existing = []
    console.log("📄 Starting with new output file")
  }

  // Combine existing and new results (simple array format)
  const combined = existing.concat(enrichedResults)

  try {
    // Save directly as JSON array without metadata wrapper
    await fs.writeFile(outputPath, JSON.stringify(combined, null, 2), "utf-8")
    console.log(
      `💾 Appended ${enrichedResults.length} Q&A pairs to ${outputPath}`,
    )
    console.log(`📈 Total Q&A pairs now: ${combined.length}`)
  } catch (error) {
    console.error("❌ Failed to write output file:", error)
    throw error
  }

  // Generate evaluation summary for new structure
  const summary = {
    totalGenerated: results.length,
    questionComplexityDistribution: {
      low: results.filter(
        (item) => item.Question_weights?.Question_Complexity === "low",
      ).length,
      medium: results.filter(
        (item) => item.Question_weights?.Question_Complexity === "medium",
      ).length,
      high: results.filter(
        (item) => item.Question_weights?.Question_Complexity === "high",
      ).length,
    },
    reasoningDistribution: {
      factBased: results.filter(
        (item) => item.Question_weights?.Reasoning === "fact-based",
      ).length,
      inferential: results.filter(
        (item) => item.Question_weights?.Reasoning === "inferential",
      ).length,
    },
    coverageDistribution: {
      low: results.filter(
        (item) => item.Question_weights?.Coverage_preference === "low",
      ).length,
      medium: results.filter(
        (item) => item.Question_weights?.Coverage_preference === "medium",
      ).length,
      high: results.filter(
        (item) => item.Question_weights?.Coverage_preference === "high",
      ).length,
    },
    questionFormatDistribution: {
      definitive: results.filter(
        (item) => item.Question_weights?.Question_format === "definitive",
      ).length,
      listing: results.filter(
        (item) => item.Question_weights?.Question_format === "listing",
      ).length,
      status: results.filter(
        (item) => item.Question_weights?.Question_format === "status",
      ).length,
    },
    averageVagueness:
      results.reduce(
        (sum, item) => sum + (item.Question_weights?.Vagueness || 0),
        0,
      ) / results.length,
    citationsPerQuestion: Array.from(docIds).length,
  }

  console.log("📋 Evaluation Summary:")
  console.log(`  - Total Generated: ${summary.totalGenerated}`)
  console.log(
    `  - Question Complexity: Low(${summary.questionComplexityDistribution.low}), Medium(${summary.questionComplexityDistribution.medium}), High(${summary.questionComplexityDistribution.high})`,
  )
  console.log(
    `  - Reasoning Types: Fact-based(${summary.reasoningDistribution.factBased}), Inferential(${summary.reasoningDistribution.inferential})`,
  )
  console.log(
    `  - Coverage Preference: Low(${summary.coverageDistribution.low}), Medium(${summary.coverageDistribution.medium}), High(${summary.coverageDistribution.high})`,
  )
  console.log(
    `  - Question Format: Definitive(${summary.questionFormatDistribution.definitive}), Listing(${summary.questionFormatDistribution.listing}), Status(${summary.questionFormatDistribution.status})`,
  )
  console.log(`  - Average Vagueness: ${summary.averageVagueness.toFixed(2)}`)
  console.log(`  - Citations per Question: ${summary.citationsPerQuestion}`)

  // Save summary to separate file
  const summaryPath =
    "/Users/arshith.balaraju/Desktop/xyne/server/xyne-evals/data/actual_data/vespa_generation_summary_actual_v1.json"
  try {
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf-8")
    console.log(`📊 Evaluation summary saved to: ${summaryPath}`)
  } catch (error) {
    console.warn("⚠️  Failed to save evaluation summary:", error)
  }

  console.log("✅ Evaluator completed successfully")
  return enrichedResults
}
