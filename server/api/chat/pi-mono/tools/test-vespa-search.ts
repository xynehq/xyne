/**
 * Simple test for searchVespaKnowledgeBase
 *
 * Run with: bun run server/api/chat/pi-mono/tools/test-vespa-search.ts
 */

import { searchVespaKnowledgeBase } from "@/search/vespa"
import { SearchModes } from "@xyne/vespa-ts/types"

async function testVespaSearch() {
  console.log("Testing searchVespaKnowledgeBase...")

  const query = "SEBI Alternative Investment Fund Regulations venture capital"
  const email = "nasim.sheikh@juspay.in"
  const offset = 80
  const limit = 30 // maxOutlines * 3 = 10 * 3

  console.log("Query:", query)
  console.log("Email:", email)
  console.log("Offset:", offset)
  console.log("Limit:", limit)

  try {
    const searchResult = await searchVespaKnowledgeBase(query, email, {
      limit: limit + offset,
      offset,
      rankProfile: SearchModes.NativeRank,
    })

    console.log("\n=== RESULT ===")
    console.log("Has results:", !!searchResult?.root?.children)
    console.log("Children count:", searchResult?.root?.children?.length || 0)

    if (searchResult?.root?.children && searchResult.root.children.length > 0) {
      console.log("\nFirst result:")
      const first = searchResult.root.children[0]
      console.log("Fields:", JSON.stringify(first.fields, null, 2))
    } else {
      console.log("No results found")
    }

    console.log("\n✅ Test completed!")
  } catch (error) {
    console.error("\n❌ Test failed:", error)
    process.exit(1)
  }
}

// Run the test
testVespaSearch()
