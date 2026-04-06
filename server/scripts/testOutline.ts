/**
 * Test script for getDocumentOutline tool
 */
import { getDocumentOutlineTool } from "@/api/chat/pi-mono/tools/get-document-outline"
import { registerSession, createInitialXyneState } from "@/api/chat/pi-mono/adapter"

async function main() {
  const query = process.argv[2] || "ESG"
  const email = process.env.TEST_EMAIL || "test@example.com"
  const sessionId = "test-session-id"

  // Initialize and register session state
  const state = createInitialXyneState(
    email,
    "test-workspace",
    "test-user",
    1,
    sessionId,
    query,
    new Date().toISOString()
  )
  registerSession(sessionId, state, async () => {})
  
  // Mock context for the execution call
  const ctx: any = { session: sessionId }

  console.log(`=== getDocumentOutline Tool Test ===`)
  console.log(`Query: "${query}"`)
  console.log(`User: ${email}`)
  console.log("")

  try {
    const result = await (getDocumentOutlineTool as any).execute(
      "test-call-id",
      { query, limit: 3 },
      new AbortController().signal,
      (update: any) => {},
      ctx
    )

    console.log("Result:")
    console.log(JSON.stringify(result, null, 2))
    
    if (result.content && result.content[0]?.text?.includes("No documents found")) {
      console.log("\n[HINT] Try a more specific or broken-down query if this failed.")
    }
  } catch (error) {
    console.error("Tool execution failed:", error)
  }
}

main().catch(console.error)
