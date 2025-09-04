 import { executeAgent } from "./api/agent/executeAgent"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
const Logger = getLogger(Subsystem.AI)


  async function testExecuteAgent() {
    console.log('🧪 Testing executeAgent function...')

    try {
      // Using your actual database data
      const result = await executeAgent({
        agentId: "zk3i1cycov8i5arrhk5u7y20", // Your first agent's external_id
        userQuery: "Hello! Can you tell me a joke?",
        workspaceId: "uxwyx18h74vdch0j8ir46aka", // Your workspace external_id
        userEmail: "aman.asrani@juspay.in",
        isStreamable: false, // Start with non-streaming for easier testing
        temperature: 0.7
      })

      if (result.success) {
        console.log('✅ Success!')
        console.log('📋 Chat ID:', result.chatId)
        console.log('📝 Title:', result.title)
        console.log('🤖 Agent:', result.agentName)
        console.log('🧠 Model:', result.modelId)

        if (result.type === 'non-streaming') {
          console.log('💬 Response:', result.response.text)
          console.log('💰 Cost:', result.response.cost)
        }
      } else {
        console.error('❌ Failed:', result.error)
        if (result.details) {
          console.error('📋 Details:', result.details)
        }
      }
    } catch (error) {
       Logger.error(error, "Error in converseStream of Together")
    }
  }

  // Run the test
  testExecuteAgent()