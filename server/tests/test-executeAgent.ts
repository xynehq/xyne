  import { executeAgent } from "../api/agent/executeAgent"
  import { getLogger } from "@/logger"
  import { Subsystem } from "@/types"
  const Logger = getLogger(Subsystem.AI)

  async function testExecuteAgent() {
    console.log('🧪 Testing executeAgent function...')

    try {
      console.log('🚀 Invoking executeAgent with test parameters...')
      const result = await executeAgent({
        agentId: "zk3i1cycov8i5arrhk5u7y20",
        userQuery: "Hello! Can you tell me a joke?",
        workspaceId: "uxwyx18h74vdch0j8ir46aka",
        userEmail: "aman.asrani@juspay.in",
        isStreamable: false,
        temperature: 0.7
      })
      console.log('🚀 Ending executeAgent with test parameters...')

      if (!result.success) {
        console.error('❌ Failed:', result.error)
        if (result.details) {
          console.error('📋 Details:', result.details)
        }
        return
      }

      console.log('✅ Success!')
      console.log('📋 Chat ID:', result.chatId)
      console.log('📝 Title:', result.title)
      console.log('🤖 Agent:', result.agentName)
      console.log('🧠 Model:', result.modelId)
      console.log('📡 Response Type:', result.type)

      // Handle BOTH streaming and non-streaming
      if (result.type === 'streaming') {
        console.log('🌊 Processing streaming response...')
        console.log('🔄 Starting iterator consumption (this will trigger the missing logs)...')

        let fullResponse = ""
        let totalCost = 0
        let chunkCount = 0

        try {
          // THIS is where you'll finally see:
          // "🌊 createStreamingWithDBSave: Starting..."
          // "🌊 createStreamingWithDBSave: About to start for-await loop..."

          for await (const chunk of result.iterator) {
            chunkCount++
            console.log(`📦 Chunk ${chunkCount}:`, JSON.stringify(chunk))

            if (chunk.text) {
              fullResponse += chunk.text
              process.stdout.write(chunk.text)  // Real-time output
            }

            if (chunk.cost) {
              totalCost += chunk.cost
            }
          }

          console.log(`\n✅ Streaming complete!`)
          console.log(`📊 Total chunks received: ${chunkCount}`)
          console.log(`📝 Full response: "${fullResponse}"`)
          console.log(`💰 Total cost: ${totalCost}`)

        } catch (streamError) {
          console.error('❌ Streaming consumption error:', streamError)
        }

      } else if (result.type === 'non-streaming') {
        console.log('💬 Non-streaming response:', result.response.text)
        console.log('💰 Cost:', result.response.cost)
      }

    } catch (error) {
      Logger.error(error, "Error in testExecuteAgent")
      console.error('💥 Test exception:', error)
    }
  }

  // Run the test
  testExecuteAgent()