/**
 * Quick test to check if fragment ranking LLM call works
 */
import { rankFragmentsByRelevance } from "@/api/chat/pi-mono/fragment-ranking"
import config from "@/config"
import type { MinimalAgentFragment } from "@/api/chat/types"

// Create some test fragments
const testFragments: MinimalAgentFragment[] = Array.from({ length: 8 }, (_, i) => ({
  id: `test-${i}`,
  content: `This is test fragment ${i} about ${
    i % 2 === 0 ? "Young Professional Program eligibility" : "SEBI recruitment policies"
  }`,
  source: {
    title: `Test Document ${i}`,
    app: "confluence",
    entity: "page",
    docId: `doc-${i}`,
  },
  confidence: 0.5 + i * 0.05,
}))

const userQuery = "What are the eligibility requirements for the Young Professional Program?"

console.log("=== Fragment Ranking Test ===")
console.log(`defaultFastModel: ${config.defaultFastModel}`)
console.log(`Fragment count: ${testFragments.length}`)
console.log(`Query: ${userQuery}`)

try {
  const result = await rankFragmentsByRelevance(testFragments, userQuery, config.defaultFastModel)
  console.log("\n=== SUCCESS ===")
  console.log(`Ranked ${result.length} fragments`)
  for (const { fragment, score } of result) {
    console.log(`  [${score}] ${fragment.source?.title} — ${fragment.content?.substring(0, 50)}`)
  }
} catch (error) {
  console.error("\n=== FAILED ===")
  console.error("Error:", error)
  if (error instanceof Error) {
    console.error("Stack:", error.stack)
  }
}
