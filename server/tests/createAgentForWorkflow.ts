import { createAgentForWorkflow } from "@/api/agent/workflowAgentUtils"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type { CreateAgentPayload } from "@/api/agent"

const Logger = getLogger(Subsystem.Db)

async function testCreateAgentHelper() {
  console.log("🧪 Testing createAgentHelper function...")

  try {
    // Test data for creating a new agent
    const agentData: CreateAgentPayload = {
      name: "Test Helper Agent",
      description: "An agent created using the createAgentHelper function",
      prompt: "You are a helpful test assistant created by the helper function",
      model: "gpt-4",
      isPublic: false,
      appIntegrations: [],
      allowWebSearch: false,
      isRagOn: true,
      uploadedFileNames: [],
      userEmails: [],
      ownerEmails: [],
      docIds: [],
    }

    const testUserId = 1
    const testWorkspaceId = 1

    console.log("📝 Creating agent with data:", {
      name: agentData.name,
      model: agentData.model,
      userId: testUserId,
      workspaceId: testWorkspaceId,
    })

    // Better error handling around the actual function call
    let result
    try {
      result = await createAgentForWorkflow(
        agentData,
        testUserId,
        testWorkspaceId,
      )
    } catch (createError) {
      if (createError instanceof Error) {
        if (createError.name === "ZodError") {
          console.error("❌ Validation Error:", createError.message)
          console.error("💡 Check your input data structure")
        } else if (createError.message.includes("Failed to create agent")) {
          console.error("❌ Database Error:", createError.message)
          console.error(
            "💡 Check your database connection and user/workspace IDs",
          )
        } else if (createError.message.includes("foreign key constraint")) {
          console.error("❌ Invalid User/Workspace ID:", createError.message)
          console.error("💡 Make sure userId and workspaceId exist in database")
        } else {
          console.error("❌ Unknown Error:", createError.message)
        }
      }
      throw createError // Re-throw to be caught by outer try-catch
    }

    console.log("✅ Agent created successfully!")
    console.log("🆔 Agent ID:", result.id)
    console.log("🔗 External ID:", result.externalId)
    console.log("📛 Name:", result.name)
    console.log("📄 Description:", result.description)
    console.log("🤖 Model:", result.model)
    console.log("👤 User ID:", result.userId)
    console.log("🏢 Workspace ID:", result.workspaceId)
    console.log("🌐 Is Public:", result.isPublic)
    console.log("📅 Created At:", result.createdAt)
  } catch (error) {
    console.error(
      "💥 Test failed:",
      error instanceof Error ? error.message : error,
    )
    Logger.error(error, "Error in createAgentHelper test")
  }
}

// Test with invalid data to see error handling
async function testCreateAgentHelperWithInvalidData() {
  console.log("\n🧪 Testing createAgentHelper with invalid data...")

  try {
    const invalidAgentData = {
      name: "", // Empty name should fail validation
      model: "gpt-4",
      // Missing required fields
    } as CreateAgentPayload

    await createAgentForWorkflow(invalidAgentData, 1, 1)
    console.log("❌ This should have failed but didn't!")
  } catch (error) {
    console.log(
      "✅ Correctly caught validation error:",
      error instanceof Error ? error.message : error,
    )
  }
}

// Run the tests
async function runAllTests() {
  await testCreateAgentHelper()
  await testCreateAgentHelperWithInvalidData()
}

runAllTests()
