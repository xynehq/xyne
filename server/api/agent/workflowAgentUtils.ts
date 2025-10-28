import { z } from "zod"
import { db } from "@/db/client"
import { getAgentByExternalId, type SelectAgent } from "@/db/agent"
import { generateTitleUsingQuery, getProviderByModel } from "@/ai/provider"
import { insertChat } from "@/db/chat"
import { insertMessage } from "@/db/message"
import { Models, type ConverseResponse } from "@/ai/types"
import { getLogger } from "@/logger"
import { getErrorMessage } from "@/utils"
import type { Message, ConversationRole } from "@aws-sdk/client-bedrock-runtime"
import { Subsystem, MessageRole, type UserMetadataType } from "@/types"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { GetDocumentsByDocIds } from "@/search/vespa" // Retrieve non-image attachments from Vespa
import { answerContextMap, cleanContext } from "@/ai/context" // Transform Vespa results to text
import { VespaSearchResultsSchema } from "@xyne/vespa-ts/types" // Type for Vespa results
import { getTracer, type Span } from "@/tracer"
import { createAgentSchema } from "@/api/agent"
import type { CreateAgentPayload } from "@/api/agent"
import { insertAgent } from "@/db/agent"
import { getDateForAI } from "@/utils/index"
import { AgentCreationSource } from "@/db/schema"
import { UnderstandMessageAndAnswer } from "@/api/chat/chat"
import { generateSearchQueryOrAnswerFromConversation, jsonParseLLMOutput } from "@/ai/provider"
import type { Citation, ImageCitation } from "@/shared/types"
import { getAgentByExternalIdWithPermissionCheck } from "@/db/agent"
import type { QueryRouterLLMResponse } from "@/ai/types"
import config from "@/config"

const {
  defaultBestModel,
} = config

const Logger = getLogger(Subsystem.Server)

export const executeAgentSchema = z.object({
  agentId: z.string().min(1, "Agent ID is required"),
  userQuery: z.string().min(1, "User query is required"),
  workspaceId: z.string().min(1, "Workspace ID is required"),
  userEmail: z.string().email("Valid email is required"),
  isStreamable: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional(),
  max_new_tokens: z.number().positive().optional(),
  attachmentFileIds: z.array(z.string()).optional().default([]),        // For images: ["att_123", "att_456"]
  nonImageAttachmentFileIds: z.array(z.string()).optional().default([]), // For PDFs: ["att_789"]
})


export type ExecuteAgentParams = z.infer<typeof executeAgentSchema>

type ExecuteAgentSuccess = {
  success: true
  chatId: string
  title: string
  agentName: string
  modelId: string
}

type StreamingExecuteAgentResponse = ExecuteAgentSuccess & {
  type: 'streaming'
  iterator: AsyncIterableIterator<ConverseResponse>
}

type NonStreamingExecuteAgentResponse = ExecuteAgentSuccess & {
  type: 'non-streaming'
  response: ConverseResponse
}

type ExecuteAgentErrorResponse = {
  success: false
  error: string
  details?: any
}

export type ExecuteAgentResponse =
  | StreamingExecuteAgentResponse
  | NonStreamingExecuteAgentResponse
  | ExecuteAgentErrorResponse


/**
 * Response from agent execution with full features
 */
export interface ExecuteAgentWithRagResponse {
  success: boolean
  response?: string                    // AI's answer
  citations?: any[]                    // Document citations
  imageCitations?: any[]               // Image citations
  thinking?: string                    // AI's reasoning (if enabled)
  cost?: string                        // API cost
  tokensUsed?: number                  // Token count
  error?: string                       // Error message (if failed)
  chatId?: string | null               // No chat for workflows
  messageId?: string | null            // No message for workflows
}

/**
 * ExecuteAgentForWorkflow - Simplified agent execution function with attachment support
 * 
 * This function provides a simplified subset of AgentMessageApi functionality:
 * 1. Generate chat title and insert in DB
 * 2. Fetch agent details from agent table (includes model)
 * 3. Process attachments (images and documents)
 * 4. Call LLM directly with agent prompt + user query + attachments
 * 5. Return response (no reasoning loop, no RAG, no tools)
 */
export const ExecuteAgentForWorkflow = async (params: ExecuteAgentParams): Promise<ExecuteAgentResponse> => {
  try {
    // Validate parameters
    const validatedParams = executeAgentSchema.parse(params)
    const tracer = getTracer("executeAgent")
    const executeAgentSpan = tracer.startSpan('executeAgent')
    const {
      agentId,
      userQuery,
      isStreamable = true,
      temperature,
      max_new_tokens,
      workspaceId,
      userEmail,
      attachmentFileIds = [],
      nonImageAttachmentFileIds = [],
    } = validatedParams

    Logger.info(`🚀 executeAgent called with parameters:`)
    Logger.info(`   - agentId: ${agentId}`)
    Logger.info(`   - userEmail: ${userEmail}`)
    Logger.info(`   - workspaceId: ${workspaceId}`)
    Logger.info(`   - userQuery length: ${userQuery.length}`)
    Logger.info(`   - isStreamable: ${isStreamable}`)
    Logger.info(`   - attachmentFileIds: ${JSON.stringify(attachmentFileIds)}`)
    Logger.info(`   - nonImageAttachmentFileIds: ${JSON.stringify(nonImageAttachmentFileIds)}`)

    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      userEmail,
    )


    const { user, workspace } = userAndWorkspace
    const userTimezone = user?.timeZone || "Asia/Kolkata"
    const dateForAI = getDateForAI({ userTimeZone: userTimezone })
    const userMetadata: UserMetadataType = { userTimezone, dateForAI }
    Logger.info(`Fetched user: ${user.id} and workspace: ${workspace.id}`)

    Logger.info(`Fetching agent details for ${agentId}...`)

    const agent = await getAgentByExternalId(db, agentId, Number(workspace.id))

    if (!agent) {
      return {
        success: false,
        error: `Agent with ID ${agentId} not found`
      }
    }

    if (!agent.model) {
      return {
        success: false,
        error: `Agent ${agentId} has no model configured`
      }
    }
    const actualModel = agent.model === "Auto" ? defaultBestModel : agent.model as Models


    Logger.info(`Found agent: ${agent.name} with model: ${agent.model}`)

    // ========================================
    // ATTACHMENT PROCESSING SECTION
    // ========================================

    let contextualContent = ""
    let finalImageFileNames: string[] = []

    Logger.info("🔍 Starting attachment processing...")
    Logger.info(`📎 Non-image attachments: ${JSON.stringify(nonImageAttachmentFileIds)}`)
    Logger.info(`🖼️ Image attachments: ${JSON.stringify(attachmentFileIds)}`)

    // Step 1: Handle Non-Image Attachments (PDFs, DOCX, etc.)
    if (nonImageAttachmentFileIds.length > 0) {
      Logger.info(`📄 Processing ${nonImageAttachmentFileIds.length} non-image attachments`)

      try {
        // Retrieve document content from Vespa (same as chat.ts:1974-1979)
        Logger.info(`🔍 Calling GetDocumentsByDocIds with IDs: ${JSON.stringify(nonImageAttachmentFileIds)}`)

        //fetching document from VESPA
        const results = await GetDocumentsByDocIds(nonImageAttachmentFileIds, executeAgentSpan!)

        Logger.info(`📊 GetDocumentsByDocIds returned: {
          hasRoot: ${!!results.root},
          hasChildren: ${!!(results.root?.children)},
          childrenCount: ${results.root?.children?.length || 0},
        }`)

        if (results.root.children && results.root.children.length > 0) {
          Logger.info(`📚 Found ${results.root.children.length} documents, transforming to readable context...`)

          // Transform Vespa results to readable context (same as chat.ts:2054-2120)
          const contextPromises = results.root.children.map(async (v, i) => {
            Logger.info(`📖 Processing document ${i} with ID: ${v.id}`)

            const content = await answerContextMap(
              v as z.infer<typeof VespaSearchResultsSchema>,
              userMetadata,
              0,    // maxSummaryChunks (0 = include all chunks)
              true, // isSelectedFiles
            )

            Logger.info(`📝 Document ${i} processed, content length: ${content.length} characters`)
            return `Index ${i} \n ${content}`
          })

          const resolvedContexts = await Promise.all(contextPromises)
          contextualContent = cleanContext(resolvedContexts.join("\n"))

          Logger.info(`✅ Context building completed!`)
          Logger.info(`📏 Total context length: ${contextualContent.length} characters`)
          Logger.info(`📄 Context preview (first 200 chars): ${contextualContent.substring(0, 200)}...`)

        } else {
          Logger.warn("⚠️ No documents found in Vespa results")
        }

      } catch (error) {
        Logger.error(error, "❌ Error processing non-image attachments")
        // Continue execution even if attachment processing fails
      }
    } else {
      Logger.info("📄 No non-image attachments to process")
    }

    // Step 2: Handle Image Attachments 
    if (attachmentFileIds.length > 0) {
      Logger.info(`🖼️ Processing ${attachmentFileIds.length} image attachments`)

      // Transform attachment IDs to image file names (same as chat.ts:2127-2131)
      finalImageFileNames = attachmentFileIds.map((fileid, index) => {
        const imageName = `${index}_${fileid}_${0}`  // Format: "0_att_123_0"
        Logger.info(`🏷️ Transformed attachment ID "${fileid}" → image name "${imageName}"`)
        return imageName
      })

      Logger.info(`🖼️ Final image file names: ${JSON.stringify(finalImageFileNames)}`)
    } else {
      Logger.info("🖼️ No image attachments to process")
    }

    Logger.info("✅ Attachment processing completed!")
    Logger.info(`📊 Summary:`)
    Logger.info(`   - Context length: ${contextualContent.length} characters`)
    Logger.info(`   - Image files: ${finalImageFileNames.length}`)

    // ========================================
    // END ATTACHMENT PROCESSING SECTION
    // ========================================

    Logger.info("Generating chat title...")

    const titleResp = await generateTitleUsingQuery(userQuery, {
      modelId: actualModel,
      stream: false,
    })
    const title = titleResp.title
    Logger.info(`Generated title: ${title}`)

    Logger.info("🔧 Building model parameters...")

    const modelParams = {
      modelId: actualModel,
      stream: isStreamable,
      json: false,
      reasoning: false,
      systemPrompt: (agent.prompt || "You are a helpful assistant.") + "\n\nIMPORTANT: Please provide responses in plain text format only. Do not use markdown.",

      // ADD IMAGE SUPPORT:
      ...(finalImageFileNames.length > 0 ? { imageFileNames: finalImageFileNames } : {}),

      ...(temperature !== undefined ? { temperature } : {}),
      ...(max_new_tokens !== undefined ? { max_new_tokens } : {}),
    }

    Logger.info(`🔧 Model parameters built: {
      modelId: ${modelParams.modelId || defaultBestModel},
      hasImages: ${!!(modelParams as any).imageFileNames},
      imageCount: ${((modelParams as any).imageFileNames || []).length},
      systemPromptLength: ${modelParams.systemPrompt.length},
      hasTemperature: ${temperature !== undefined},
      hasMaxTokens: ${max_new_tokens !== undefined},
    }`)

    Logger.info("💬 Constructing LLM messages...")

    // UPDATE MESSAGE CONSTRUCTION TO INCLUDE CONTEXT:
    const userContent = contextualContent
      ? `Context from attached documents:\n${contextualContent}\n\nUser Query: ${userQuery}`  // Include document context
      : userQuery  // No context, just user query

    Logger.info(`💬 Message construction details: {
      hasContext: ${!!contextualContent},
      contextLength: ${contextualContent.length},
      userQueryLength: ${userQuery.length},
      finalContentLength: ${userContent.length},
    }`)

    Logger.info("💬 Final user content preview (first 300 chars):")
    Logger.info(userContent.substring(0, 300) + (userContent.length > 300 ? "..." : ""))

    const messages: Message[] = [
      {
        role: "user" as ConversationRole,
        content: [{ text: userContent }],  // User query + document context
      }
    ]

    Logger.info("💬 Messages array constructed with 1 user message")

    Logger.info(`Calling LLM with model ${actualModel}...`)

    const insertedChat = await insertChat(db, {
      workspaceId: workspace.id,
      workspaceExternalId: workspace.externalId,
      userId: user.id,
      email: userEmail,
      title,
      attachments: [],
      agentId: agent.externalId,
    })

    await insertMessage(db, {
      chatId: insertedChat.id,
      userId: user.id,
      chatExternalId: insertedChat.externalId,
      workspaceExternalId: workspace.externalId,
      messageRole: MessageRole.User,
      email: userEmail,
      sources: [],
      message: userQuery,
      modelId: agent.model,
    })

    // Step 6: Call LLM and return based on streaming preference
    if (isStreamable) {
      Logger.info("🌊 Agent execution started (streaming mode)")
      Logger.info(`🌊 About to call LLM with attachments: {
        hasImages: ${finalImageFileNames.length > 0},
        imageFiles: ${finalImageFileNames},
        hasContext: ${contextualContent.length > 0},
        contextLength: ${contextualContent.length},
      }`)

      // Add provider debugging
      const provider = getProviderByModel(actualModel)
      Logger.info(`🤖 Provider for model ${actualModel}: ${typeof provider}`)

      try {
        Logger.info("🔄 Creating original iterator...")
        const originalIterator = provider.converseStream(messages, modelParams)
        Logger.info("🔄 Original iterator created, starting wrapper...")

        const wrappedIterator = createStreamingWithDBSave(originalIterator, {
          chatId: insertedChat.id,
          userId: user.id,
          chatExternalId: insertedChat.externalId,
          workspaceExternalId: workspaceId,
          email: userEmail,
          modelId: actualModel,
        })

        Logger.info("✅ Wrapper created successfully")

        return {
          success: true,
          type: 'streaming',
          iterator: wrappedIterator,
          chatId: insertedChat.externalId,
          title,
          agentName: agent.name,
          modelId: actualModel,
        }
      } catch (providerError) {
        Logger.error(providerError, "❌ Error creating streaming iterator")
        throw providerError
      }
    } else {
      Logger.info("💫 Agent execution started (non-streaming mode)")
      Logger.info(`💫 About to call LLM with attachments: {
        hasImages: ${finalImageFileNames.length > 0},
        imageFiles: ${finalImageFileNames},
        hasContext: ${contextualContent.length > 0},
        contextLength: ${contextualContent.length},
      }`)

      // Get non-streaming response
      const response = await getProviderByModel(actualModel).converse(
        messages,
        modelParams
      )

      Logger.info(`💫 LLM response received: {
        hasText: ${!!response.text},
        textLength: ${response.text?.length || 0},
        hasCost: ${!!response.cost},
        cost: ${response.cost},
      }`)

      if (!response.text) {
        return {
          success: false,
          error: "No response received from LLM"
        }
      }

      await insertMessage(db, {
        chatId: insertedChat.id,
        userId: user.id,
        chatExternalId: insertedChat.externalId,
        workspaceExternalId: workspace.externalId,
        messageRole: MessageRole.Assistant,
        email: userEmail,
        sources: [],
        message: response.text,
        modelId: actualModel,
        cost: response.cost?.toString(),
      })

      Logger.info("✅ Agent execution completed successfully (non-streaming)")

      return {
        success: true,
        type: 'non-streaming',
        chatId: insertedChat.externalId,
        title,
        response: response,
        agentName: agent.name,
        modelId: actualModel,
      }
    }

  } catch (error) {

    Logger.error(error, "Error in executeAgent")

    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: "Invalid request parameters",
        details: error.flatten().fieldErrors,
      }
    }

    return {
      success: false,
      error: getErrorMessage(error),
    }
  }
}

async function* createStreamingWithDBSave(
  originalIterator: AsyncIterableIterator<ConverseResponse>,
  dbSaveParams: {
    chatId: number
    userId: number
    chatExternalId: string
    workspaceExternalId: string
    email: string
    modelId: string
  }
): AsyncIterableIterator<ConverseResponse> {


  Logger.info("🌊 createStreamingWithDBSave: Starting...")
  let answer = ""
  let costArr: number[] = []
  let tokenArr: { inputTokens: number; outputTokens: number }[] = []
  let wasStreamClosedPrematurely = false

  try {
    Logger.info("🌊 createStreamingWithDBSave: About to start for-await loop...")

    for await (const chunk of originalIterator) {
      if (chunk.text) {
        answer += chunk.text  // Accumulate full response
        yield { text: chunk.text }  // Forward to client
      }
      Logger.info(`🌊 createStreamingWithDBSave: Forwarded chunk to client: ${chunk.text}`)

      if (chunk.cost) {
        costArr.push(chunk.cost)  // Accumulate costs
        yield { cost: chunk.cost }
      }

      if (chunk.metadata?.usage) {
        tokenArr.push({  // Accumulate token usage
          inputTokens: chunk.metadata.usage.inputTokens,
          outputTokens: chunk.metadata.usage.outputTokens,
        })
        yield { metadata: chunk.metadata }
      }
    }

    Logger.info("🌊 createStreamingWithDBSave: Iterator completed, saving to DB...")

    // Save to DB after stream completes (same pattern as AgentMessageApi)
    if (answer || wasStreamClosedPrematurely) {
      const totalCost = costArr.reduce((sum, cost) => sum + cost, 0)
      const totalTokens = tokenArr.reduce(
        (sum, tokens) => sum + tokens.inputTokens + tokens.outputTokens,
        0,
      )


      await insertMessage(db, {
        chatId: dbSaveParams.chatId,
        userId: dbSaveParams.userId,
        chatExternalId: dbSaveParams.chatExternalId,
        workspaceExternalId: dbSaveParams.workspaceExternalId,
        messageRole: MessageRole.Assistant,
        email: dbSaveParams.email,
        sources: [],
        message: answer,  // Full accumulated text
        modelId: dbSaveParams.modelId,
        cost: totalCost.toString(),
        tokensUsed: totalTokens,
      })

      Logger.info("Assistant message saved to database after streaming")
    }

  } catch (error) {
    Logger.error(error, "Error during streaming or DB save")
    throw error
  }
}


export const executeAgentForWorkflowWithRag = async (params: ExecuteAgentParams): Promise<ExecuteAgentWithRagResponse> => {
  try {
    Logger.info(`[agentCore] Starting execution for agent ${params.agentId}`)

    // Validate with Zod schema
    const validatedParams = executeAgentSchema.parse(params)

    // Initialize tracer for performance monitoring
    const tracer = getTracer("agentCore")
    const executeAgentSpan = tracer.startSpan('executeAgentCore')

    // ============================================
    // STEP 1: Load User, Workspace, and Agent
    // ============================================

    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      params.workspaceId,
      params.userEmail,
    )
    const { user, workspace } = userAndWorkspace

    Logger.info(`[agentCore] Resolved user ID: ${user.id}, workspace ID: ${workspace.id}`)

    const agent = await getAgentByExternalIdWithPermissionCheck(
      db,
      validatedParams.agentId,
      workspace.id,
      user.id,
    )
    //here add attachements id's in app_integrations : google_drive : [...attachmentFileIds]

    if (!agent) {
      Logger.error(`[agentCore] Agent ${params.agentId} not found or permission denied`)
      return {
        success: false,
        error: `Access denied: You don't have permission to use agent ${params.agentId}`,
      }
    }

    Logger.info(`[agentCore] Loaded agent: ${agent.name}`)
    Logger.info(`[agentCore] Agent features: RAG=${agent.isRagOn}, Integrations=${agent.appIntegrations?.length || 0}`)

    // ============================================
    const userTimezone = user?.timeZone || "Asia/Kolkata"
    const dateForAI = getDateForAI({ userTimeZone: userTimezone })
    const userMetadata: UserMetadataType = { userTimezone, dateForAI }

    Logger.info(`[agentCore] User timezone: ${userTimezone}, Date for AI: ${dateForAI}`)

    let contextualContent = ""


    // Extract KB from BOTH sources:
    const agentKBDocs = agent.docIds || []
    const directDocIds = agentKBDocs.map((doc) =>
      typeof doc === 'string' ? doc : doc.docId
    )

    // Extract KB from app_integrations
    let kbIntegrationDocIds: string[] = []
    if (agent.appIntegrations && typeof agent.appIntegrations === 'object') {
      const integrations = agent.appIntegrations as Record<string, any>
      if (integrations.knowledge_base && integrations.knowledge_base.itemIds) {
        kbIntegrationDocIds = integrations.knowledge_base.itemIds
      }
    }

    // Combine ALL sources
    const agentKBDocIds = [...directDocIds, ...kbIntegrationDocIds]

    // Merge with user attachments
    const uniqueFileIds = Array.from(new Set([
      ...agentKBDocIds,
    ]))



    Logger.info(`[agentCore] 📊 Combined file sources:`)

    Logger.info(`[agentCore]    - Agent KB docs: ${agentKBDocs.length}`)
    Logger.info(`[agentCore]    - Total unique files: ${uniqueFileIds.length}`)

    // Determine if we should use RAG
    const shouldUseRAG = agent.isRagOn && uniqueFileIds.length > 0 // RAG enabled and files available


    // ============================================
    // TODO: Step 4 - Perform RAG search or direct LLM call
    // ===========================================



    let finalAnswer = ""
    let citations: Citation[] = []
    let imageCitations: ImageCitation[] = []
    let thinking = ""
    let totalCost = 0
    let totalTokens = 0



    if (shouldUseRAG) {
      // ===== Path 1: RAG Pipeline =====
      // Why? Agent has RAG enabled and files available
      // We search the documents and use context to answer

      Logger.info(`[agentCore] 🔍 Starting RAG pipeline...`)

      const ragSpan = executeAgentSpan?.startSpan("rag_processing")
      const understandSpan = ragSpan?.startSpan("understand_message")

      // Call RAG function (async generator that yields chunks)

      const classification = await classifyUserQuery(
        params.userQuery,
        params.userEmail,
        userMetadata,
        agent.model === "Auto" ? undefined : agent.model,
      )
      Logger.info(`[agentCore] 📊 Classification result: ${JSON.stringify(classification)}`)


      // this UnderstandMessageAndAnswerForGivenContext is only for the attachment files and do Rag on them not consider the app_integrations

      // const iterator = UnderstandMessageAndAnswerForGivenContext(
      //     params.userEmail,                     // email
      //     params.userQuery,                     // userCtx (context from user)
      //     userMetadata,                         // timezone, date
      //     params.userQuery,                     // message (the question)
      //     0.5,                                  // alpha (search confidence threshold)
      //     uniqueFileIds,                        // fileIds (documents to search)
      //     false,                                // userRequestsReasoning
      //     understandSpan,                       // tracing span
      //     [],                                   // threadIds (empty for workflows)
      //     imageAttachmentFileIds,               // image attachments
      //     agent.prompt || undefined,   // agent's system prompt
      //     true,                                 // isMsgWithSources
      //     agent.model === "Auto" ? undefined : agent.model,             // model ID
      //     undefined,                            // isValidPath
      //     [],                                   // folderIds
      // )

      // STEP 2: Call UnderstandMessageAndAnswer
      // Why? This function properly extracts KB from app_integrations
      // It internally calls generateIterativeTimeFilterAndQueryRewrite which parses the agent JSON
      const iterator = UnderstandMessageAndAnswer(
        params.userEmail,           // email
        params.userEmail,           // userCtx (user context - can be same as email for workflows)
        userMetadata,               // timezone, date
        params.userQuery,           // message (the question)
        classification,             // QueryRouterLLMResponse from classifyUserQuery
        [],                         // messages (empty array for workflows - no conversation history)
        0.5,                        // alpha (search confidence threshold)
        false,                      // userRequestsReasoning
        understandSpan,             // tracing span
        JSON.stringify(agent),      // agentPrompt - CRITICAL: Must be stringified full agent with app_integrations!
        agent.model === "Auto" ? undefined : agent.model,  // modelId
        undefined,                  // pathExtractedInfo (not needed for workflows)
      )


      // Iterate through response chunks
      // Why? The function streams chunks (text, citations, costs)
      for await (const chunk of iterator) {
        if (chunk.text) {
          // Regular answer text
          if (!chunk.reasoning) {
            finalAnswer += chunk.text
          } else {
            // Thinking/reasoning text (if enabled)
            thinking += chunk.text
          }
        }

        if (chunk.citation) {
          // Document citation
          citations.push(chunk.citation.item)
        }

        if (chunk.imageCitation) {
          // Image citation
          imageCitations.push(chunk.imageCitation)
        }

        if (chunk.cost) {
          // API cost
          totalCost += chunk.cost
        }

        if (chunk.metadata?.usage) {
          // Token usage
          totalTokens += chunk.metadata.usage.inputTokens + chunk.metadata.usage.outputTokens
        }
      }

      understandSpan?.end()
      ragSpan?.end()

      Logger.info(`[agentCore] ✅ RAG pipeline completed`)
      Logger.info(`[agentCore] 📊 Answer length: ${finalAnswer.length} characters`)
      Logger.info(`[agentCore] 📚 Citations: ${citations.length}`)
      Logger.info(`[agentCore] 💰 Cost: $${totalCost.toFixed(6)}`)

    } else {
      // ===== Path 2: Direct LLM Call =====
      // Why? RAG is disabled or no files available
      // We just call the LLM with the agent's prompt

      Logger.info(`[agentCore] 🤖 Starting direct LLM call (no RAG)...`)

      const llmSpan = executeAgentSpan?.startSpan("direct_llm_call")



      const result = await ExecuteAgentForWorkflow({
        agentId: params.agentId,
        userQuery: params.userQuery,
        userEmail: params.userEmail,
        workspaceId: params.workspaceId,
        isStreamable: false,
        attachmentFileIds: params.attachmentFileIds || [],
        nonImageAttachmentFileIds: params.nonImageAttachmentFileIds || [],
        temperature: params.temperature,

      })

      Logger.info(`[agentCore] Direct LLM call result: ${JSON.stringify(result).substring(0, 700)}...`)

      // Extract the response text from the result
      if (result.success && result.type === "non-streaming") {
        finalAnswer = result.response?.text || ""
        totalCost = result.response?.cost || 0
        totalTokens = (result.response?.metadata?.usage?.inputTokens || 0) +
                      (result.response?.metadata?.usage?.outputTokens || 0)
        Logger.info(`[agentCore] ✅ Successfully extracted response text (${finalAnswer.length} chars)`)
      } else if (!result.success) {
        Logger.error(`[agentCore] Agent execution failed: ${result.error}`)
        finalAnswer = `Error: ${result.error}`
      }

      llmSpan?.end()

      Logger.info(`[agentCore] ✅ Direct LLM call completed`)
      Logger.info(`[agentCore] 📊 Answer length: ${finalAnswer.length} characters`)
      Logger.info(`[agentCore] 💰 Cost: $${totalCost.toFixed(6)}`)
    }

    executeAgentSpan?.end()

    // Return final response
    return {
      success: true,
      response: finalAnswer,
      citations: citations.length > 0 ? citations : undefined,
      imageCitations: imageCitations.length > 0 ? imageCitations : undefined,
      thinking: thinking || undefined,
      cost: totalCost > 0 ? totalCost.toFixed(6) : undefined,
      tokensUsed: totalTokens,
      chatId: null,      // No chat for workflows
      messageId: null,   // No message for workflows
    }




  } catch (error) {
    Logger.error(error, "[agentCore] Agent execution failed")
    return {
      success: false,
      error: getErrorMessage(error)
    }
  }
}



/**
 * Classify user query to determine RAG routing strategy
 */
async function classifyUserQuery(
  userQuery: string,
  userEmail: string,
  userMetadata: UserMetadataType,
  modelId?: string,
): Promise<QueryRouterLLMResponse> {
  Logger.info(`[agentCore] 🔍 Classifying user query...`)

  const classificationIterator = generateSearchQueryOrAnswerFromConversation(
    userQuery,
    userEmail,
    userMetadata,
    {
      modelId: (modelId as Models) || defaultBestModel,
      stream: true,
      json: true,
    },
  )

  let classificationText = ""
  for await (const chunk of classificationIterator) {
    if (chunk.text) {
      classificationText += chunk.text
    }
  }

  const classification = jsonParseLLMOutput(classificationText)

  const result: QueryRouterLLMResponse = {
    type: classification.type || "SearchWithoutFilters",
    direction: classification.direction || null,
    filterQuery: classification.filter_query || null,
    filters: {
      apps: classification.apps || null,
      entities: classification.entities || null,
      startTime: classification.start_time || null,
      endTime: classification.end_time || null,
      sortDirection: classification.sort_direction || null,
      count: classification.count || 5,
      offset: classification.offset || 0,
       ...(classification.intent ? { intent: classification.intent } : {}),
    },
  }

  Logger.info(`[agentCore] ✅ Query classified as: ${result.type}`)
  return result
}


//this function will be used to be called by workflow feature
export const createAgentForWorkflow = async (
  agentData: CreateAgentPayload,
  userId: number,
  workspaceId: number
): Promise<SelectAgent> => {
  try {
    const validatedBody = createAgentSchema.parse(agentData)

    const agentDataForInsert = {
      name: validatedBody.name,
      description: validatedBody.description,
      prompt: validatedBody.prompt,
      model: validatedBody.model,
      isPublic: validatedBody.isPublic,
      appIntegrations: validatedBody.appIntegrations,
      allowWebSearch: validatedBody.allowWebSearch,
      isRagOn: validatedBody.isRagOn,
      uploadedFileNames: validatedBody.uploadedFileNames,
      docIds: validatedBody.docIds,
      creation_source: AgentCreationSource.WORKFLOW,
    }

    const newAgent = await db.transaction(async (tx) => {
      return await insertAgent(tx, agentDataForInsert, userId, workspaceId)
    })

    return newAgent
  } catch (error) {
    // Re-throw validation errors as-is for the caller to handle
    // Logger.error(error, `Failed to create agent: ${getErrorMessage(error)}`)
    if (error instanceof z.ZodError) {
      throw error
    }

    // Wrap other errors with more context
    const errMsg = getErrorMessage(error)
    throw new Error(`Failed to create agent: ${errMsg}`)
  }
}
