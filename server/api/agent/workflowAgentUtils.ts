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
import { UnderstandMessageAndAnswer, UnderstandMessageAndAnswerForGivenContext } from "@/api/chat/chat"
import { generateSearchQueryOrAnswerFromConversation, jsonParseLLMOutput } from "@/ai/provider"
import type { Citation, ImageCitation } from "@/shared/types"
import { getAgentByExternalIdWithPermissionCheck } from "@/db/agent"
import type { QueryRouterLLMResponse } from "@/ai/types"
import config from "@/config"
import { getWorkflowStepTemplatesByTemplateId } from "@/db/workflow"
import { getWorkflowToolsByIds } from "@/db/workflowTool"
import { eq } from "drizzle-orm"
import { userAgentPermissions, users } from "@/db/schema"

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

export interface UnauthorizedAgentInfo {
  agentId: string
  agentName: string
  toolId: string
  missingUserEmails: string[]
}

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
        cost: (response.cost || 0).toString(),
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
        cost: (totalCost || 0).toString(),
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

    // Merge with user attachments from workflow form submissions
    const uniqueFileIds = Array.from(new Set([
      ...agentKBDocIds,
      ...(params.nonImageAttachmentFileIds || []), // Add PDF/document attachments from workflow
      ...(params.attachmentFileIds || []),         // Add image attachments from workflow
    ]))



    Logger.info(`[agentCore] 📊 Combined file sources:`)
    Logger.info(`[agentCore]    - Agent KB docs: ${agentKBDocIds.length}`)
    Logger.info(`[agentCore]    - Workflow PDF attachments: ${params.nonImageAttachmentFileIds?.length || 0}`)
    Logger.info(`[agentCore]    - Workflow image attachments: ${params.attachmentFileIds?.length || 0}`)
    Logger.info(`[agentCore]    - Total unique files: ${uniqueFileIds.length}`)

    // Determine if we should use RAG
    const hasWorkflowAttachments = (params.attachmentFileIds && params.attachmentFileIds.length > 0) ||
                                  (params.nonImageAttachmentFileIds && params.nonImageAttachmentFileIds.length > 0)
    const shouldUseRAG = (agent.isRagOn && uniqueFileIds.length > 0) || hasWorkflowAttachments // RAG enabled and files available OR workflow has attachments
    
    Logger.info(`[agentCore] 🔍 RAG Decision:`, {
      agentIsRagOn: agent.isRagOn,
      uniqueFileIdsLength: uniqueFileIds.length,
      hasWorkflowAttachments: hasWorkflowAttachments,
      shouldUseRAG: shouldUseRAG,
      agentKBDocs: agentKBDocs.length,
      kbIntegrationDocIds: kbIntegrationDocIds.length
    })


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


      // STEP 2: Choose appropriate RAG function based on whether we have attachments
      // If we have attachment files, use UnderstandMessageAndAnswerForGivenContext
      // Otherwise, use UnderstandMessageAndAnswer for app_integrations
      
      const hasAttachments = (params.attachmentFileIds && params.attachmentFileIds.length > 0) ||
                           (params.nonImageAttachmentFileIds && params.nonImageAttachmentFileIds.length > 0)
      
      let iterator: AsyncIterableIterator<any>
      
      if (hasAttachments) {
        Logger.info(`[agentCore] 🔗 Using UnderstandMessageAndAnswerForGivenContext for ${params.attachmentFileIds?.length || 0} image attachments and ${params.nonImageAttachmentFileIds?.length || 0} document attachments`)
        
        // Debug: Validate attachment IDs to ensure they're properly formatted
        if (params.nonImageAttachmentFileIds && params.nonImageAttachmentFileIds.length > 0) {
          Logger.info(`[agentCore] 📎 PDF attachment IDs:`, params.nonImageAttachmentFileIds.map(id => ({
            id: id,
            type: typeof id,
            length: id ? id.length : 0,
            isString: typeof id === 'string',
            startsWithAtt: typeof id === 'string' && id.startsWith('att_')
          })))
        }
        
        // CRITICAL: If we have document attachments but they're not in uniqueFileIds, that's a problem
        if (params.nonImageAttachmentFileIds && params.nonImageAttachmentFileIds.length > 0) {
          const missingFromFileIds = params.nonImageAttachmentFileIds.filter(id => !uniqueFileIds.includes(id))
          if (missingFromFileIds.length > 0) {
            Logger.error(`[agentCore] ❌ CRITICAL: Document attachment IDs missing from uniqueFileIds!`, {
              missingIds: missingFromFileIds,
              providedDocumentIds: params.nonImageAttachmentFileIds,
              uniqueFileIds: uniqueFileIds,
              uniqueFileIdsCount: uniqueFileIds.length
            })
          } else {
            Logger.info(`[agentCore] ✅ All document attachment IDs found in uniqueFileIds`)
          }
        }
        
        // Debug: Log exactly what we're passing to the RAG function
        Logger.info(`[agentCore] 🔍 UnderstandMessageAndAnswerForGivenContext parameters:`, {
          email: params.userEmail,
          userCtx: params.userEmail,
          message: params.userQuery,
          alpha: 0.5,
          fileIds: uniqueFileIds,
          fileIdsCount: uniqueFileIds.length,
          threadIds: [],
          attachmentFileIds: params.attachmentFileIds || [],
          agentPromptType: typeof (agent.prompt || JSON.stringify(agent)),
          agentPromptLength: (agent.prompt || JSON.stringify(agent)).length,
          isMsgWithSources: true,
          modelId: agent.model === "Auto" ? undefined : agent.model,
          isValidPath: undefined,
          folderIds: []
        })

        // Use the attachment-specific RAG function
        // Note: For PDFs, they should go in fileIds parameter, not attachmentFileIds
        iterator = UnderstandMessageAndAnswerForGivenContext(
          params.userEmail,                     // email
          params.userEmail,                     // userCtx (context from user)
          userMetadata,                         // timezone, date
          params.userQuery,                     // message (the question)
          0.5,                                  // alpha (search confidence threshold)
          uniqueFileIds,                        // fileIds (ALL documents including PDFs)
          false,                                // userRequestsReasoning
          understandSpan,                       // tracing span
          [],                                   // threadIds (empty for workflows)
          params.attachmentFileIds || [],       // attachmentFileIds (ONLY for images)
          agent.prompt || JSON.stringify(agent), // agent's system prompt or full agent
          true,                                 // isMsgWithSources
          agent.model === "Auto" ? undefined : agent.model, // model ID
          undefined,                            // isValidPath
          [],                                   // folderIds
        )
      } else {
        Logger.info(`[agentCore] 🔗 Using UnderstandMessageAndAnswer for app_integrations (no attachments)`)
        
        // Use the standard RAG function for app_integrations
        iterator = UnderstandMessageAndAnswer(
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
      }


      // Iterate through response chunks
      // Why? The function streams chunks (text, citations, costs)
      let chunkCount = 0
      for await (const chunk of iterator) {
        chunkCount++
        Logger.info(`[agentCore] 📥 Received chunk ${chunkCount}:`, {
          hasText: !!chunk.text,
          textLength: chunk.text?.length || 0,
          textPreview: chunk.text?.substring(0, 100) + (chunk.text?.length > 100 ? "..." : ""),
          hasReasoning: !!chunk.reasoning,
          hasCitation: !!chunk.citation,
          hasImageCitation: !!chunk.imageCitation,
          hasCost: !!chunk.cost,
          hasMetadata: !!chunk.metadata,
          chunkKeys: Object.keys(chunk)
        })

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
          Logger.info(`[agentCore] 📖 Document citation received:`, {
            index: chunk.citation.index,
            itemKeys: Object.keys(chunk.citation.item),
            title: chunk.citation.item.title,
            relevance: chunk.citation.item.relevance
          })
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

      Logger.info(`[agentCore] 📦 RAG processing complete:`, {
        totalChunks: chunkCount,
        finalAnswerLength: finalAnswer.length,
        finalAnswerPreview: finalAnswer.substring(0, 200) + (finalAnswer.length > 200 ? "..." : ""),
        citationsCount: citations.length,
        imageCitationsCount: imageCitations.length,
        totalCost: totalCost,
        totalTokens: totalTokens,
        citationTitles: citations.map(c => c.title || 'No title'),
        hadDocumentAttachments: params.nonImageAttachmentFileIds && params.nonImageAttachmentFileIds.length > 0,
        expectedDocumentCount: params.nonImageAttachmentFileIds?.length || 0
      })

      // CRITICAL CHECK: If we expected documents but got no citations, that's a problem
      if (params.nonImageAttachmentFileIds && params.nonImageAttachmentFileIds.length > 0 && citations.length === 0) {
        Logger.error(`[agentCore] ❌ CRITICAL: Expected ${params.nonImageAttachmentFileIds.length} document(s) but got 0 citations!`, {
          expectedDocuments: params.nonImageAttachmentFileIds,
          finalAnswerContainsError: finalAnswer.includes('no content') || finalAnswer.includes('not provided') || finalAnswer.includes('unable to'),
          answerLength: finalAnswer.length
        })
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
      Logger.info(`[agentCore] 📝 Query parameters:`, {
        agentId: params.agentId,
        userQueryLength: params.userQuery.length,
        userQueryPreview: params.userQuery.substring(0, 200) + "...",
        userEmail: params.userEmail,
        workspaceId: params.workspaceId,
        temperature: params.temperature,
        hasAttachmentFileIds: (params.attachmentFileIds || []).length > 0,
        hasNonImageAttachmentFileIds: (params.nonImageAttachmentFileIds || []).length > 0
      })

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

      // Extract the response from the result
      if (result.success && result.type === 'non-streaming') {
        // The response object structure: { text: string, cost?: number, metadata?: any }
        finalAnswer = result.response?.text || ""
        Logger.info(`[agentCore] Extracted AI response: "${finalAnswer.substring(0, 200)}..." (length: ${finalAnswer.length})`)
        
        // Log the full response structure for debugging
        Logger.info(`[agentCore] Full response structure:`, {
          hasResponse: !!result.response,
          responseKeys: result.response ? Object.keys(result.response) : [],
          textValue: result.response?.text,
          textLength: result.response?.text?.length || 0
        })
        
        if (!finalAnswer) {
          Logger.error(`[agentCore] AI response is empty! Response object:`, result.response)
          finalAnswer = "AI response was empty"
        }
      } else if (result.success && result.type === 'streaming') {
        Logger.warn(`[agentCore] Unexpected streaming result in non-streaming mode`)
        finalAnswer = "AI response was in streaming format but expected non-streaming"
      } else {
        Logger.error(`[agentCore] AI execution failed: ${JSON.stringify(result)}`)
        finalAnswer = `AI execution failed: ${result.error || 'Unknown error'}`
      }

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
        llmSpan?.end()
        executeAgentSpan?.end()
        return {
          success: false,
          error: result.error
        }
      } else {
        // This case is unexpected since isStreamable is set to false.
        Logger.warn(`[agentCore] Agent execution returned a streaming response unexpectedly.`)
        finalAnswer = "Error: Unexpected streaming response from agent."
        llmSpan?.end()
        executeAgentSpan?.end()
        return {
          success: false,
          error: "Unexpected streaming response from agent"
        }
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

/**
 * Checks if there are any tools in the workflow that are created by the user (isExistingAgent 
 * set to true) and the permissions of that agent don't match the workflow updated permissions
 * 
 * @param workflowTemplateId - The internal ID of the workflow template
 * @param updatedUserEmails - Array of user emails that will have access to the workflow
 * @param workspaceId - The workspace ID for the workflow
 * @returns Object with hasUnauthorized flag and details of unauthorized agents
 */
export async function hasUnauthorizedAgent(
  workflowTemplateId: string,
  updatedUserEmails: string[],
  workspaceId: number
): Promise<{
  hasUnauthorized: boolean
  unauthorizedAgents: UnauthorizedAgentInfo[]
}> {
  try {
    Logger.info(`Checking unauthorized agents for workflow ${workflowTemplateId}`)

    // 1. Get all step templates for this workflow
    const stepTemplates = await getWorkflowStepTemplatesByTemplateId(db, workflowTemplateId)

    if (stepTemplates.length === 0) {
      Logger.info(`No step templates found for workflow ${workflowTemplateId}`)
      return { hasUnauthorized: false, unauthorizedAgents: [] }
    }

    // 2. Get all tool IDs from all steps
    const allToolIds = stepTemplates.flatMap(step => step.toolIds as string[] || [])

    if (allToolIds.length === 0) {
      Logger.info(`No tools found in workflow ${workflowTemplateId}`)
      return { hasUnauthorized: false, unauthorizedAgents: [] }
    }

    // 3. Get all tools for this workflow
    const tools = await getWorkflowToolsByIds(db, allToolIds)

    // 4. Filter tools that are AI agents with existing agents
    const aiAgentTools = tools.filter(tool => {
      const config = tool.config as any
      return (
        tool.type === 'ai_agent' && 
        config?.isExistingAgent === true && 
        config?.agentId
      )
    })

    if (aiAgentTools.length === 0) {
      Logger.info(`No existing AI agent tools found in workflow ${workflowTemplateId}`)
      return { hasUnauthorized: false, unauthorizedAgents: [] }
    }

    Logger.info(`Found ${aiAgentTools.length} existing AI agent tools to check`)

    const unauthorizedAgents: UnauthorizedAgentInfo[] = []

    // 5. For each AI agent tool, check if agent permissions match workflow permissions
    for (const tool of aiAgentTools) {
      const config = tool.config as any
      const agentExternalId = config.agentId

      try {
        // Get the agent details
        const agentRecord = await getAgentByExternalId(db, agentExternalId, workspaceId)

        if (!agentRecord) {
          Logger.warn(`Agent ${agentExternalId} not found in workspace ${workspaceId}`)
          continue
        }

        // If agent is public, no authorization check needed
        if (agentRecord.isPublic) {
          Logger.info(`Agent ${agentExternalId} is public, skipping authorization check`)
          continue
        }

        // Get all users who have access to this agent
        const agentPermissions = await db
          .select({
            userEmail: users.email,
            role: userAgentPermissions.role
          })
          .from(userAgentPermissions)
          .innerJoin(users, eq(userAgentPermissions.userId, users.id))
          .where(eq(userAgentPermissions.agentId, agentRecord.id))

        // Get agent owner
        const agentOwner = await db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, agentRecord.userId))
          .limit(1)

        // Collect all emails that have access to the agent
        const agentAccessEmails = new Set<string>()
        
        // Add owner
        if (agentOwner.length > 0) {
          agentAccessEmails.add(agentOwner[0].email.toLowerCase())
        }

        // Add users with permissions
        for (const permission of agentPermissions) {
          agentAccessEmails.add(permission.userEmail.toLowerCase())
        }

        // Convert updatedUserEmails to lowercase for comparison
        const normalizedUpdatedEmails = updatedUserEmails.map(email => email.toLowerCase())

        // Check if all workflow users have access to the agent
        const missingUserEmails: string[] = []
        for (const workflowUserEmail of normalizedUpdatedEmails) {
          if (!agentAccessEmails.has(workflowUserEmail)) {
            missingUserEmails.push(workflowUserEmail)
          }
        }

        if (missingUserEmails.length > 0) {
          Logger.warn(
            `Agent ${agentExternalId} (${agentRecord.name}) is not accessible to users: ${missingUserEmails.join(', ')}`
          )
          unauthorizedAgents.push({
            agentId: agentExternalId,
            agentName: agentRecord.name,
            toolId: tool.id,
            missingUserEmails
          })
        }

      } catch (agentError) {
        Logger.error(
          agentError,
          `Error checking permissions for agent ${agentExternalId} in tool ${tool.id}`
        )
        // Continue with other agents instead of failing completely
      }
    }

    const hasUnauthorized = unauthorizedAgents.length > 0

    if (hasUnauthorized) {
      Logger.warn(
        `Found ${unauthorizedAgents.length} unauthorized agents in workflow ${workflowTemplateId}`
      )
    } else {
      Logger.info(`All agents in workflow ${workflowTemplateId} are properly authorized`)
    }

    return {
      hasUnauthorized,
      unauthorizedAgents
    }

  } catch (error) {
    Logger.error(error, `Failed to check unauthorized agents for workflow ${workflowTemplateId}`)
    // Return false to allow workflow update in case of check failure
    // This prevents the authorization check from blocking legitimate updates
    return { hasUnauthorized: false, unauthorizedAgents: [] }
  }
}
