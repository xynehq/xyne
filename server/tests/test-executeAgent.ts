import { ExecuteAgentForWorkflow } from "@/api/agent/workflowAgentUtils"
  import { getLogger } from "@/logger"
  import { Subsystem } from "@/types"

  const Logger = getLogger(Subsystem.AI)

  async function testExecuteAgent() {
    console.log('🧪 Testing ExecuteAgentForWorkflow function...')

    try {
      console.log('🚀 Invoking ExecuteAgentForWorkflow with test parameters...')
      const result = await ExecuteAgentForWorkflow({
        agentId: "zk3i1cycov8i5arrhk5u7y20",
        userQuery: "Can you summarize the attached resume?",
        workspaceId: "uxwyx18h74vdch0j8ir46aka",
        userEmail: "aman.asrani@juspay.in",
        isStreamable: false,
        temperature: 0.7,
        // ✅ UPDATED WITH FRESH ATTACHMENT ID:
        attachmentFileIds: [], // Empty array for images
        nonImageAttachmentFileIds: ["att_a9b4896e-044a-4391-82d7-2befd06a40e7"], // Fresh Anant's resume
      })
      console.log('🚀 Ending ExecuteAgentForWorkflow with test parameters...')

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

  // Test with image attachment (when you have an image attachment ID)
  async function testExecuteAgentWithImageAttachment() {
    console.log('🧪 Testing ExecuteAgentForWorkflow with image attachment...')

    const result = await ExecuteAgentForWorkflow({
      agentId: "zk3i1cycov8i5arrhk5u7y20",
      userQuery: "What does this image show?",
      workspaceId: "uxwyx18h74vdch0j8ir46aka",
      userEmail: "aman.asrani@juspay.in",
      isStreamable: false,
      temperature: 0.7,
      attachmentFileIds: ["att_a9b4896e-044a-4391-82d7-2befd06a40e7"], // This resume has 1 embedded image!
      nonImageAttachmentFileIds: [], // Empty array for documents
    })

    console.log('🖼️ Image test result:', result.success ? 'SUCCESS' : result.error)
    if (result.success && result.type === 'non-streaming') {
      console.log('🖼️ Image response:', result.response.text)
    }
  }

  // Test with both PDF content and embedded image
  async function testExecuteAgentWithMixedAttachments() {
    console.log('🧪 Testing ExecuteAgentForWorkflow with PDF text + embedded image...')

    const result = await ExecuteAgentForWorkflow({
      agentId: "zk3i1cycov8i5arrhk5u7y20",
      userQuery: "Analyze the resume content and describe any images or visual elements you see",
      workspaceId: "uxwyx18h74vdch0j8ir46aka",
      userEmail: "aman.asrani@juspay.in",
      isStreamable: false,
      temperature: 0.7,
      // ✨ INTERESTING: This resume has BOTH text content AND embedded images!
      attachmentFileIds: ["att_a9b4896e-044a-4391-82d7-2befd06a40e7"], // Images extracted from PDF
      nonImageAttachmentFileIds: ["att_a9b4896e-044a-4391-82d7-2befd06a40e7"], // Text content from PDF
    })

    console.log('🔀 Mixed test result:', result.success ? 'SUCCESS' : result.error)
    if (result.success && result.type === 'non-streaming') {
      console.log('🔀 Mixed response:', result.response.text?.substring(0, 200) + '...')
    }
  }

  async function testExecuteAgentWithoutAttachments() {
    console.log('🧪 Testing ExecuteAgentForWorkflow without attachments...')

    const result = await ExecuteAgentForWorkflow({
      agentId: "zk3i1cycov8i5arrhk5u7y20",
      userQuery: "Hello! Can you tell me a joke?",
      workspaceId: "uxwyx18h74vdch0j8ir46aka",
      userEmail: "aman.asrani@juspay.in",
      isStreamable: false,
      temperature: 0.7,
      attachmentFileIds: [], // Empty arrays
      nonImageAttachmentFileIds: [],
    })

    console.log('🗣️ No attachments test result:', result.success ? 'SUCCESS' : result.error)
    if (result.success && result.type === 'non-streaming') {
      console.log('🗣️ Joke response:', result.response.text)
    }
  }

  // Run the tests
  async function runAllTests() {
    console.log('🧪🧪🧪 Running all ExecuteAgentForWorkflow tests...\n')

    // Test 1: PDF content analysis  
    await testExecuteAgent()
    console.log('\n' + '='.repeat(50) + '\n')

    // Test 2: Image analysis (PDF has embedded images!)
    // await testExecuteAgentWithImageAttachment()
    // console.log('\n' + '='.repeat(50) + '\n')

    // // Test 3: Both text and images from same PDF
    await testExecuteAgentWithMixedAttachments()
    console.log('\n' + '='.repeat(50) + '\n')

    // // Test 4: No attachments baseline
    await testExecuteAgentWithoutAttachments()

    console.log('\n🎉 All tests completed!')
  }

  // Run the test
  runAllTests()