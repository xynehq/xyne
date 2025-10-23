import * as fs from "fs/promises"
import * as path from "path"
import { fileURLToPath } from "url"
import type { QAItem } from "./types"

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export async function evaluator(results: QAItem[], docIds: Set<string>) {
  console.log("📊 Starting evaluator...")
  console.log(`🔍 Received ${results.length} results to evaluate`)

  const filtered = results.filter((item) => item.Confidence > 0.7)
  console.log(`✅ Filtered to ${filtered.length} items with confidence > 0.7`)

  const enrichedFiltered = filtered.map((item) => ({
    ...item,
    citations: Array.from(docIds),
  }))

  const outputPath = path.join(__dirname, "flipkart_scenario_qa.json")
  let existing: (QAItem & { citations?: string[] })[] = []
  try {
    const data = await fs.readFile(outputPath, "utf-8")
    existing = JSON.parse(data)
    if (!Array.isArray(existing)) existing = []
  } catch (e) {
    // File does not exist or is invalid, start fresh
    existing = []
  }
  const combined = existing.concat(enrichedFiltered)
  await fs.writeFile(outputPath, JSON.stringify(combined, null, 2), "utf-8")
  console.log(
    `Appended ${enrichedFiltered.length} Q&A pairs with confidence > 0.7 to ${outputPath}`,
  )
  return enrichedFiltered
}
